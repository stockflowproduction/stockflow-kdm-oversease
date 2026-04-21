import { DeleteCompensationArtifactDto } from '../../../contracts/v1/finance-artifacts/finance-artifact.types';

export type DeleteCompensationArtifactDocument = DeleteCompensationArtifactDto;

export const deleteCompensationArtifactSchemaDefinition = {
  id: 'string',
  storeId: 'string',
  transactionId: 'string',
  customerId: 'string|null',
  customerName: 'string|null',
  amount: 'number',
  mode: 'string',
  reason: 'string|null',
  createdAt: 'string',
  createdBy: 'string|null',
} as const;
