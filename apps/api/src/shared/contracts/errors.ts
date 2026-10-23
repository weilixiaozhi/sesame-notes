import { Type } from '@sinclair/typebox';

export const ErrorSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    request_id: Type.String(),
    details: Type.Optional(Type.Unknown()),
  },
  { $id: 'Error' },
);
