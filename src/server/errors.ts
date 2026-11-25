export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'BUSY' | 'RATE_LIMIT'
  | 'REAUTH_REQUIRED' | 'MFA_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED' | 'PAYMENT_REQUIRED' | 'SERVER_ERROR';

export class AppError extends Error {
  code: ErrorCode;
  fields?: Record<string, string>;
  constructor(code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}
export function vErr(field: string, msg: string): AppError {
  return new AppError('VALIDATION', 'Periksa kembali isian Anda.', { [field]: msg });
}
