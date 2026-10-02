export class RouterError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}
