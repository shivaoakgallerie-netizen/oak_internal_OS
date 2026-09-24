/* Browser-only prototype storage. Request metadata never contains object URLs. */
const DATABASE_NAME = 'oak-workflow-prototype';
const DATABASE_VERSION = 1;
const CURRENT_WORKSPACE = 'current';
let databasePromise = null;

function storageError(error, action = 'save the prototype') {
  const name = error?.name;
  let message;
  if (name === 'QuotaExceededError') {
    message = 'This browser has run out of storage for the prototype. Free some space or use smaller attachments, then try again.';
  } else if (name === 'SecurityError' || name === 'NotAllowedError') {
    message = 'Browser storage is disabled. Allow site storage to keep prototype requests and attachments after a reload.';
  } else if (name === 'DataCloneError') {
    message = 'The prototype could not save this data. Attachments must be saved as files and request details as plain data.';
  } else {
    message = `Could not ${action} in this browser. Your latest changes may only be available until this page closes.`;
  }
  return new Error(message, { cause: error });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      if (!globalThis.indexedDB) {
        fail(new Error('Browser storage is unavailable. Prototype changes and attachments cannot be kept after a reload.'));
        return;
      }
      request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      fail(storageError(error, 'open prototype storage'));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('workspace')) database.createObjectStore('workspace');
      if (!database.objectStoreNames.contains('media')) database.createObjectStore('media', { keyPath: 'id' });
    };
    request.onblocked = () => fail(new Error('Prototype storage is blocked by another open tab. Close the other Oak Gallerie tabs and reload this page.'));
    request.onerror = () => fail(storageError(request.error, 'open prototype storage'));
    request.onsuccess = () => {
      const database = request.result;
      // A blocked open may eventually finish after the caller has already failed.
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      database.onclose = () => { databasePromise = null; };
      resolve(database);
    };
  });
  databasePromise.catch(() => { databasePromise = null; });
  return databasePromise;
}

async function transact(stores, mode, action, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let failure;
    try {
      transaction = database.transaction(stores, mode);
    } catch (error) {
      reject(storageError(error, action));
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(storageError(failure || transaction.error, action));
    transaction.onerror = event => { failure ||= event.target?.error || transaction.error; };
    const observe = (request, onSuccess) => {
      request.onerror = () => { failure ||= request.error; };
      if (onSuccess) request.onsuccess = () => onSuccess(request.result);
      return request;
    };
    try {
      operation(transaction, observe, value => { result = value; });
    } catch (error) {
      failure = error;
      // A synchronous cloning or validation failure must roll back every write.
      try { transaction.abort(); } catch { reject(storageError(error, action)); }
    }
  });
}

/** Load metadata only; attachment bytes are retrieved separately on demand. */
export function loadDemo() {
  return transact(['workspace'], 'readonly', 'load the prototype', (transaction, observe, setResult) => {
    observe(transaction.objectStore('workspace').get(CURRENT_WORKSPACE), value => setResult(value ?? null));
  });
}

/** Commit metadata and any new { id, blob } attachment entries atomically. */
export async function saveDemo(state, attachments = []) {
  for (const attachment of attachments) {
    if (typeof attachment?.id !== 'string' || !attachment.id || !(attachment.blob instanceof Blob)) {
      throw new Error('An attachment could not be saved. Select the original photo or video file and try again.');
    }
  }
  return transact(['workspace', 'media'], 'readwrite', 'save the prototype', (transaction, observe) => {
    observe(transaction.objectStore('workspace').put(state, CURRENT_WORKSPACE));
    const media = transaction.objectStore('media');
    for (const { id, blob } of attachments) observe(media.put({ id, blob }));
  });
}

export function getAttachmentBlob(id) {
  return transact(['media'], 'readonly', 'load this attachment', (transaction, observe, setResult) => {
    observe(transaction.objectStore('media').get(id), value => setResult(value?.blob ?? null));
  });
}

/** Reset metadata and all uploaded media in one transaction. */
export function resetDemo(state) {
  return transact(['workspace', 'media'], 'readwrite', 'reset the prototype', (transaction, observe) => {
    const workspace = transaction.objectStore('workspace');
    observe(workspace.clear());
    observe(transaction.objectStore('media').clear());
    observe(workspace.put(state, CURRENT_WORKSPACE));
  });
}
