/**
 * Closed network recipes shared by the trusted profile qualifier and the
 * guardian-owned managed network keeper. These values are not package input.
 */
export type FixedNetworkAddressFamily = 'ipv4' | 'ipv6';
export type FixedProfileNetworkCategory =
  | 'link-local'
  | 'loopback'
  | 'metadata-class'
  | 'private'
  | 'ula';

export interface FixedProfileNetworkTarget {
  readonly category: FixedProfileNetworkCategory;
  readonly cidr?: string;
  readonly family: FixedNetworkAddressFamily;
  readonly host: string;
}

export const FIXED_PROFILE_NETWORK_TARGETS: readonly FixedProfileNetworkTarget[] = Object.freeze([
  Object.freeze({ category: 'loopback', family: 'ipv4', host: '127.0.0.1' }),
  Object.freeze({
    category: 'private',
    cidr: '10.23.45.1/24',
    family: 'ipv4',
    host: '10.23.45.1',
  }),
  Object.freeze({
    category: 'link-local',
    cidr: '169.254.77.1/24',
    family: 'ipv4',
    host: '169.254.77.1',
  }),
  Object.freeze({
    category: 'metadata-class',
    cidr: '169.254.169.253/32',
    family: 'ipv4',
    host: '169.254.169.253',
  }),
  Object.freeze({
    category: 'ula',
    cidr: 'fd42:515d:4::1/64',
    family: 'ipv6',
    host: 'fd42:515d:4::1',
  }),
]);

export function fixedProfileNetworkAddresses(): readonly string[] {
  return Object.freeze(
    FIXED_PROFILE_NETWORK_TARGETS.flatMap((target) =>
      target.cidr === undefined ? [] : [target.cidr],
    ),
  );
}
