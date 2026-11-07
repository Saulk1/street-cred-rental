"use strict";

globalThis.PROPERTY_REPORT = (() => {
  const SUMMARY = 'microburbs.report.summary';
  const TTL = 15 * 60 * 1000;
  const ALARM = 'microburbs-property-report';
  let writes = Promise.resolve(), running;
  const serial = operation => {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  };
  const key = (job, task) => JSON.stringify([job.origin, task.path]);
  function summary(job) {
    return { id: job.id, candidate: job.candidate, state: job.state, updatedAt: job.updatedAt,
      selectedAt: job.selectedAt, total: job.tasks.length,
      completed: job.tasks.filter(t => !['pending', 'loading'].includes(t.status)).length,
      errors: job.tasks.filter(t => t.status === 'error').length, error: job.error };
  }
  async function publish(job) {
    job.updatedAt = Date.now();
    await REPORT_STORE.save(job);
    await chrome.storage.local.set({ [SUMMARY]: summary(job) });
  }
  function schedule(job) {
    if (!chrome.alarms) return;
    if (job?.state === 'running') chrome.alarms.create(ALARM, { delayInMinutes: 1 });
    else void chrome.alarms.clear(ALARM);
  }
  async function confirm(candidate, refresh = false) {
    const origin = PROPERTY_API.origin();
    const result = await serial(async () => {
      const previous = await REPORT_STORE.job();
      if (!refresh && previous?.candidate.id === candidate.id && previous.origin === origin && Date.now() - previous.selectedAt < TTL) {
        return previous;
      }
      await REPORT_STORE.prune(Date.now() - TTL);
      const job = { id: crypto.randomUUID(), candidate, origin, selectedAt: Date.now(), updatedAt: Date.now(),
        state: 'running', tasks: REPORT_PLAN.start(candidate), fresh: refresh };
      await publish(job);
      return job;
    });
    schedule(result);
    // Start the durable job independently of the popup/card's lifetime.
    void pump();
    return { ok: true, report: summary(result) };
  }
  function append(job, tasks) {
    const known = new Set(job.tasks.map(t => t.id));
    for (const task of tasks) if (!known.has(task.id)) { job.tasks.push(task); known.add(task.id); }
  }
  function expand(job, task, envelope) {
    if (task.endpoint === REPORT_PLAN.profilePath) {
      if (envelope?.data && typeof envelope.data === 'object') job.profile = envelope.data;
      // A failed profile still produces visible skipped dependent sections.
      if (job.profile) job.tasks = job.tasks.filter(t => t.status !== 'skipped');
      append(job, REPORT_PLAN.geographic(job.profile));
    }
    if (task.endpoint === REPORT_PLAN.fieldsPath) {
      job.fields = envelope?.data;
      const returned = job.fields?.fields?.length ?? 0;
      if (Number(job.fields?.count) > returned) task.notice = `API field catalog returned ${returned} of ${job.fields.count} fields; the documented catalog limit is 500.`;
    }
    if (job.profile && job.fields && !job.statisticsExpanded) {
      const tasks = REPORT_PLAN.statistics(job.profile, job.fields);
      if (tasks.length) job.tasks = job.tasks.filter(t => !(t.endpoint === REPORT_PLAN.valuesPath && t.status === 'skipped'));
      append(job, tasks);
      if (tasks.length) job.statisticsExpanded = true;
    }
    const page = envelope && REPORT_PLAN.nextPage(task, envelope);
    if (page) append(job, [page]);
    // Not every dataset exposes pagination. Preserve and label API-side caps.
    if (envelope && !page) {
      const data = envelope.data, meta = data?.meta ?? envelope.meta;
      if (meta?.truncated || meta?.clamped || meta?.capped || meta?.has_more || meta?.next_offset != null) task.notice = 'The API reports capped or additional results. See full response metadata.';
    }
  }
  async function execute(job, task) {
    const saved = !job.fresh && !task.force && await REPORT_STORE.result(key(job, task));
    if (saved && Date.now() - saved.savedAt < TTL) return { task, envelope: saved.envelope, savedAt: saved.savedAt };
    try {
      const envelope = await PROPERTY_API.raw(task.path);
      const savedAt = Date.now();
      await REPORT_STORE.put({ key: key(job, task), savedAt, envelope });
      return { task, envelope, savedAt };
    } catch (error) {
      return { task, error: error.detail ?? { code: 'storage', message: 'Could not fetch or save this result. Retry this endpoint.' } };
    }
  }
  async function batch() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await serial(async () => {
        const current = await REPORT_STORE.job();
        if (!current || current.state !== 'running') return;
        if (current.origin !== PROPERTY_API.origin()) {
          current.state = 'paused'; current.error = 'API configuration changed. Refresh this report to use the new configuration.';
          await publish(current); return;
        }
        return current;
      });
      if (!job) return;
      const tasks = job.tasks.filter(t => t.status === 'pending' && (!t.retryAt || t.retryAt <= Date.now())).slice(0, 2);
      if (!tasks.length) {
        await serial(async () => {
          const current = await REPORT_STORE.job();
          if (current?.id !== job.id) return;
          if (!current.tasks.some(t => t.status === 'pending')) current.state = 'complete';
          await publish(current); schedule(current);
        });
        return;
      }
      const results = await Promise.all(tasks.map(task => execute(job, task)));
      const same = await serial(async () => {
        const current = await REPORT_STORE.job();
        if (current?.id !== job.id) return false;
        for (const result of results) {
          const task = current.tasks.find(t => t.id === result.task.id);
          task.attempts++;
          if (result.error) {
            task.error = result.error;
            const limited = result.error.code === 'rate_limit';
            task.status = limited && task.attempts < 3 ? 'pending' : 'error';
            task.retryAt = result.error.retryAt ?? (Date.now() + 1000);
            if (['authentication', 'configuration', 'storage'].includes(result.error.code)) {
              current.state = 'paused'; current.error = result.error.message;
            }
            if (task.endpoint === REPORT_PLAN.profilePath) expand(current, task);
          } else {
            const data = result.envelope.data;
            task.status = result.envelope.available === false ? 'unavailable'
              : data === null || (Array.isArray(data) && !data.length) ? 'empty' : 'ok';
            task.savedAt = result.savedAt; task.error = undefined;
            task.reason = typeof result.envelope.reason === 'string' ? result.envelope.reason
              : typeof result.envelope.message === 'string' ? result.envelope.message : undefined;
            expand(current, task, result.envelope);
          }
        }
        if (current.state === 'running' && !current.tasks.some(t => t.status === 'pending')) current.state = 'complete';
        await publish(current); schedule(current);
        return true;
      });
      if (!same) return;
    }
  }
  function pump() {
    if (running) return running;
    running = batch().catch(async () => {
      // Never expose exceptions containing API payloads or credentials.
      await serial(async () => {
        const job = await REPORT_STORE.job();
        if (!job) return;
        job.state = 'paused'; job.error = 'Could not continue the report. Check API configuration and available storage, then retry.';
        await publish(job); schedule(job);
      }).catch(() => {});
    }).finally(() => { running = undefined; });
    return running;
  }
  async function read() {
    await writes;
    const job = await REPORT_STORE.job();
    if (!job) return { ok: true, report: null };
    return { ok: true, report: { ...summary(job), tasks: job.tasks.map(({ identifiers, query, path, documentation, ...task }) => task), supporting: REPORT_PLAN.supporting } };
  }
  async function result(reportId, taskId) {
    await writes;
    const job = await REPORT_STORE.job();
    const task = job?.id === reportId && job.tasks.find(t => t.id === taskId);
    if (!task) return { ok: false };
    return { ok: true, result: (await REPORT_STORE.result(key(job, task)))?.envelope ?? null, documentation: task.documentation };
  }
  async function retry(reportId, taskId) {
    await serial(async () => {
      const job = await REPORT_STORE.job();
      if (job?.id !== reportId) return;
      const task = job.tasks.find(t => t.id === taskId);
      if (!task || !['error', 'unavailable', 'empty'].includes(task.status)) return;
      task.status = 'pending'; task.attempts = 0; task.retryAt = undefined;
      // Force a new response for this task, not the cached failure/empty value.
      task.force = true;
      job.state = 'running'; job.error = undefined;
      await publish(job); schedule(job);
    });
    void pump();
    return { ok: true };
  }
  // Chrome can discard alarms across reloads/restarts. Recreate only when work exists.
  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) return pump(); });
    const recover = () => chrome.storage.local.get(SUMMARY).then(values => {
      if (values[SUMMARY]?.state === 'running') { schedule(values[SUMMARY]); void pump(); }
    }).catch(() => {});
    chrome.runtime?.onStartup?.addListener(recover);
    void recover();
  }
  return Object.freeze({ confirm, read, result, retry, pump });
})();
