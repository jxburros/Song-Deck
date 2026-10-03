/**
 * Voice safety and consent (spec §36): voice conversion/cloning requires confirmation that the
 * user is authorized to use the target voice. Stock synthetic voices need no attestation.
 */
import type { VoiceConsent } from '@songdeck/core';
import { ConsentRequiredError } from './errors';
import type { VoiceConversionProvider, VoiceConversionRequest, VoiceTarget } from './types';

/** A consent attestation is valid when it names who attests, the rights holder, a basis and a date. */
export function isValidConsent(c: VoiceConsent | undefined): c is VoiceConsent {
  return !!c && !!c.attestedBy?.trim() && !!c.rightsHolder?.trim() && !!c.basis && !!c.attestedAt && Number.isFinite(Date.parse(c.attestedAt));
}

/** Throws ConsentRequiredError unless the voice is stock or valid consent is supplied. */
export function assertVoiceConsent(target: VoiceTarget, consent?: VoiceConsent): void {
  if (target.kind === 'stock') return;
  if (isValidConsent(consent) || isValidConsent(target.consent)) return;
  throw new ConsentRequiredError(target.id, target.kind);
}

/** Wrap any VoiceConversionProvider (including app-registered internal ones) with the consent check. */
export function withConsentGuard(provider: VoiceConversionProvider): VoiceConversionProvider {
  const guarded: VoiceConversionProvider = {
    async convertVoice(req: VoiceConversionRequest) {
      assertVoiceConsent(req.targetVoice, req.consent);
      return provider.convertVoice(req);
    },
  };
  if (provider.listVoices) guarded.listVoices = provider.listVoices.bind(provider);
  return guarded;
}
