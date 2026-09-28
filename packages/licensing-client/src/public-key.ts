/**
 * The Sentrello license verification key.
 *
 * Public keys are meant to be public: this ships in the open-source core so any
 * instance can verify a license token offline, with no network call and nothing
 * to configure. The matching private key exists only on sentrello.com's control
 * plane host.
 *
 * Rotating it is a breaking change for every instance in the field — a build
 * carrying the old key cannot verify tokens signed by a new one. If it ever has
 * to happen, ship a release that accepts both, wait for the fleet to update,
 * then drop the old one.
 */
export const SENTRELLO_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIolhK7dpfmkiCDtgITLc6tR09ju/zZ8jJDT/cmt1O5E=
-----END PUBLIC KEY-----
`;

/**
 * Every key an instance will accept, newest first.
 *
 * Rotation without disrupting customers needs two keys trusted at once:
 *
 *   1. ship a release trusting [old, new]
 *   2. wait for instances to update
 *   3. switch the control plane to sign with the new key
 *   4. ship a release that drops the old one
 *
 * Without this the only way to replace a compromised key is to break every
 * instance in the field simultaneously — so the array exists from the start
 * even while it holds a single entry.
 */
export const SENTRELLO_LICENSE_PUBLIC_KEYS: string[] = [
  SENTRELLO_LICENSE_PUBLIC_KEY,
];
