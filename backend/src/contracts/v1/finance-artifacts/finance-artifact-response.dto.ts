import { DeleteCompensationArtifactDto, UpdateCorrectionDeltaArtifactDto } from './finance-artifact.types';

export class DeleteCompensationArtifactListResponseDto {
  items!: DeleteCompensationArtifactDto[];
  total!: number;
}

export class UpdateCorrectionDeltaArtifactListResponseDto {
  items!: UpdateCorrectionDeltaArtifactDto[];
  total!: number;
}

export class DeleteCompensationArtifactResponseDto {
  artifact!: DeleteCompensationArtifactDto;
}

export class DeleteCompensationArtifactSummaryResponseDto {
  totals!: {
    count: number;
    amount: number;
  };

  byMode!: Array<{
    mode: DeleteCompensationArtifactDto['mode'];
    count: number;
    amount: number;
  }>;

  latestCreatedAt!: string | null;
}

export class UpdateCorrectionDeltaArtifactResponseDto {
  artifact!: UpdateCorrectionDeltaArtifactDto;
}

export class UpdateCorrectionDeltaArtifactSummaryResponseDto {
  totals!: {
    count: number;
    delta: UpdateCorrectionDeltaArtifactDto['delta'];
  };

  byChangeTag!: Array<{
    changeTag: string;
    count: number;
  }>;

  latestUpdatedAt!: string | null;
}
