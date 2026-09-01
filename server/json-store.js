import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonStore {
  constructor(filePath, createInitialState, transforms = {}) {
    this.filePath = filePath;
    this.createInitialState = createInitialState;
    this.serialize = transforms.serialize || ((state) => state);
    this.deserialize = transforms.deserialize || ((state) => state);
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write(await this.createInitialState());
    }
  }

  async read() {
    await this.queue;
    return this.deserialize(JSON.parse(await readFile(this.filePath, "utf8")));
  }

  update(mutator) {
    const operation = this.queue.then(async () => {
      const state = this.deserialize(JSON.parse(await readFile(this.filePath, "utf8")));
      const result = await mutator(state);
      await this.write(state);
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async write(state) {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.serialize(state), null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}
