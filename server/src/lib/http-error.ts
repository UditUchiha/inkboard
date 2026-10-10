export class HttpError extends Error {
  // `declare` keeps this a type only: Node strips it, and the assignment below still creates the field.
  declare status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
