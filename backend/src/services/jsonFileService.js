const fs = require('node:fs/promises');
const path = require('node:path');

function createJsonFileService(dataDirectory, allowedFiles) {
  const writeQueues = new Map();

  function getFilePath(fileName) {
    if (!allowedFiles.includes(fileName) || path.basename(fileName) !== fileName) {
      throw new Error(`JSON file is not allowed: ${fileName}`);
    }
    return path.join(dataDirectory, fileName);
  }

  async function readFile(filePath, fileName) {
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      return JSON.parse(contents);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in ${fileName}: ${error.message}`);
      }
      throw error;
    }
  }

  async function writeFileAtomically(filePath, fileName, data) {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(`Could not write ${fileName}: ${error.message}`);
    }
  }

  function runSerializedWrite(filePath, operation) {
    const previousWrite = writeQueues.get(filePath) || Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => undefined)
      .then(operation);

    writeQueues.set(filePath, nextWrite);
    return nextWrite.finally(() => {
      if (writeQueues.get(filePath) === nextWrite) {
        writeQueues.delete(filePath);
      }
    });
  }

  async function createIfMissing(fileName, defaultData) {
    const filePath = getFilePath(fileName);

    await runSerializedWrite(filePath, async () => {
      try {
        await fs.access(filePath);
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error(`Could not check ${fileName}: ${error.message}`);
        }
      }

      await writeFileAtomically(filePath, fileName, defaultData);
    });
  }

  async function readJson(fileName, defaultData) {
    const filePath = getFilePath(fileName);
    await fs.mkdir(dataDirectory, { recursive: true });

    try {
      return await readFile(filePath, fileName);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.message.startsWith('Invalid JSON')) {
          throw error;
        }
        throw new Error(`Could not read ${fileName}: ${error.message}`);
      }
    }

    await createIfMissing(fileName, defaultData);
    return readFile(filePath, fileName);
  }

  async function writeJson(fileName, data) {
    const filePath = getFilePath(fileName);
    return runSerializedWrite(filePath, () => writeFileAtomically(filePath, fileName, data));
  }

  // The update function receives the current complete JSON value and returns its replacement.
  // Keep unrelated array records by changing only the matching item in that function.
  async function updateJson(fileName, updateFunction, defaultData) {
    const filePath = getFilePath(fileName);

    return runSerializedWrite(filePath, async () => {
      await fs.mkdir(dataDirectory, { recursive: true });
      let currentData;

      try {
        currentData = await readFile(filePath, fileName);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error.message.startsWith('Invalid JSON')) {
            throw error;
          }
          throw new Error(`Could not read ${fileName}: ${error.message}`);
        }
        currentData = defaultData;
      }

      const updatedData = await updateFunction(currentData);
      await writeFileAtomically(filePath, fileName, updatedData);
      return updatedData;
    });
  }

  // Replace one matching array record and keep every other record unchanged.
  async function upsertArrayItem(fileName, idField, item, defaultData = []) {
    if (item[idField] === undefined || item[idField] === null) {
      throw new Error(`The record must include its ${idField} field.`);
    }

    return updateJson(fileName, (currentData) => {
      if (!Array.isArray(currentData)) {
        throw new Error(`${fileName} must contain a JSON array to update a record.`);
      }

      const matchingIndex = currentData.findIndex((record) =>
        record && record[idField] === item[idField],
      );

      if (matchingIndex === -1) {
        return [...currentData, item];
      }

      const updatedRecords = [...currentData];
      updatedRecords[matchingIndex] = { ...updatedRecords[matchingIndex], ...item };
      return updatedRecords;
    }, defaultData);
  }

  return { readJson, writeJson, updateJson, upsertArrayItem };
}

const { DATA_DIRECTORY, DATA_FILES } = require('../config/config');
const jsonFileService = createJsonFileService(DATA_DIRECTORY, Object.values(DATA_FILES));

module.exports = { createJsonFileService, jsonFileService };
