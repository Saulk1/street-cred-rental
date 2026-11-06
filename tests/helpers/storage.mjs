export const noteKey = id => `microburbs.note.${id}`;
export const note = (id, text = id, createdAt = 1, type = "manual") => ({ id, text, createdAt, type });
export const settle = () => new Promise(resolve => setImmediate(resolve));

// Model separate keys and change events, sharing one backing store across contexts.
export function storageMock(initial = {}) {
  const data = structuredClone(initial);
  const listeners = [];
  const storage = {
    local: {
      async get() { return structuredClone(data); },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        for (const listener of listeners) listener(changes, "local");
      },
      async remove(key) {
        const changes = { [key]: { oldValue: data[key] } };
        delete data[key];
        for (const listener of listeners) listener(changes, "local");
      },
    },
    onChanged: { addListener: listener => listeners.push(listener), removeListener: listener => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } },
  };
  return { storage, data, listeners };
}
