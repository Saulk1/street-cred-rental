"use strict";

globalThis.REPORT_STORE = (() => {
  let database;
  function open() {
    return database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('microburbs-property-reports', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('jobs');
        db.createObjectStore('results', { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = () => { database = undefined; reject(request.error); };
      request.onblocked = () => { database = undefined; reject(new Error('Report database is blocked.')); };
    });
  }
  async function action(store, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  }
  return Object.freeze({
    job: () => action('jobs', 'readonly', store => store.get('active')),
    save: job => action('jobs', 'readwrite', store => store.put(job, 'active')),
    result: key => action('results', 'readonly', store => store.get(key)),
    put: result => action('results', 'readwrite', store => store.put(result)),
    async prune(before) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('results', 'readwrite');
        const cursor = tx.objectStore('results').index('savedAt').openCursor(IDBKeyRange.upperBound(before));
        cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
  });
})();
