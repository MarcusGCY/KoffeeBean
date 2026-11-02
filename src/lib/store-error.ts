export class StoreUnavailableError extends Error {
  constructor() {
    super("store_unavailable");
    this.name = "StoreUnavailableError";
  }
}
