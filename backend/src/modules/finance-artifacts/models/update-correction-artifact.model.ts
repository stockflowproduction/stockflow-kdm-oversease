import { UpdateCorrectionDeltaArtifactDto } from '../../../contracts/v1/finance-artifacts/finance-artifact.types';

export type UpdateCorrectionArtifactDocument = UpdateCorrectionDeltaArtifactDto;

export const updateCorrectionArtifactSchemaDefinition = {
  id: 'string',
  storeId: 'string',
  originalTransactionId: 'string',
  updatedTransactionId: 'string',
  customerId: 'string|null',
  customerName: 'string|null',
  changeTags: 'array<string>',
  delta: 'deltaSnapshot',
  updatedAt: 'string',
  updatedBy: 'string|null',
} as const;
