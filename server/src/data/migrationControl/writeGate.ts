import { GovernanceMigrationControlInvariantError, type GovernanceMigrationControl } from './types.js';

interface ControlReader {
  getControl(): Promise<GovernanceMigrationControl>;
}

export class GovernanceWriteGate {
  constructor(private readonly controls: ControlReader) {}

  async assertLegacyWriteAllowed(input: {
    actor: 'user' | 'service';
    compatibilityProjection: boolean;
  }): Promise<void> {
    const control = await this.controls.getControl();
    if (input.actor === 'service' && input.compatibilityProjection
      && control.compatibilityProjectionEnabled) return;
    throw new GovernanceMigrationControlInvariantError('MIGRATION_LEGACY_WRITE_SEALED');
  }

  async enforcementMode(): Promise<'shadow' | 'enforce'> {
    const control = await this.controls.getControl();
    return control.mode === 'enforce' ? 'enforce' : 'shadow';
  }
}
