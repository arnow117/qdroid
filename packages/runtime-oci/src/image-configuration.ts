export interface DockerImageConfiguration {
  readonly Healthcheck?: unknown;
  readonly Labels?: Readonly<Record<string, string>>;
  readonly OnBuild?: unknown;
  readonly Volumes?: unknown;
}

/**
 * Docker has represented omitted image configuration differently across API
 * versions: omitted, null, and empty collections all mean that no inherited
 * behaviour will run. A nonempty configuration is never treated as inert.
 */
export function hasOnlyInertImageConfiguration(configuration: DockerImageConfiguration): boolean {
  return (
    hasNoOnBuildTriggers(configuration.OnBuild) &&
    hasNoHealthcheckCommand(configuration.Healthcheck) &&
    hasNoVolumes(configuration.Volumes)
  );
}

function hasNoOnBuildTriggers(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function hasNoHealthcheckCommand(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;

  const command = value.Test;
  if (command === undefined) return false;
  if (!Array.isArray(command)) return false;
  return command.length === 0 || (command.length === 1 && command[0] === 'NONE');
}

function hasNoVolumes(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
