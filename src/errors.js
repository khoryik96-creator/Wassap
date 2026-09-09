/**
 * An error we raise deliberately, whose message is already written for the
 * person running the command. The CLI prints these as-is, with no stack trace.
 */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
  }
}
