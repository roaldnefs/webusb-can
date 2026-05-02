// ═══════════════════════════════════════════════════════
//  UDS (ISO 14229) — diagnostic services over ISO-TP
// ═══════════════════════════════════════════════════════

import { isoTpRequest } from './isotp.js';

// Subset of NRCs. Anything not listed is rendered as "0xNN".
export const NRC_NAMES = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x25: 'noResponseFromSubnetComponent',
  0x26: 'failurePreventsExecutionOfRequestedAction',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceedNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x70: 'uploadDownloadNotAccepted',
  0x71: 'transferDataSuspended',
  0x72: 'generalProgrammingFailure',
  0x73: 'wrongBlockSequenceCounter',
  0x78: 'requestCorrectlyReceived-ResponsePending',
  0x7E: 'subFunctionNotSupportedInActiveSession',
  0x7F: 'serviceNotSupportedInActiveSession',
};

const NEGATIVE_RESP = 0x7F;
const NRC_PENDING = 0x78;

// Send a UDS request and parse the response.
// Auto-handles 0x78 (response pending) by waiting for the real response;
// the ISO-TP timer is reset each time a pending NRC arrives.
// Returns:
//   { ok: true,  sid, data }            on positive response
//   { ok: false, sid, nrc, name }       on negative response
export async function udsRequest(txId, rxId, request, { timeoutMs = 2000 } = {}) {
  if (!request.length) throw new Error('UDS: empty request');
  const reqSid = request[0];

  const isFinal = (resp) => !(
    resp.length >= 3 && resp[0] === NEGATIVE_RESP && resp[2] === NRC_PENDING
  );

  const response = await isoTpRequest(txId, rxId, request, { timeoutMs, isFinal });

  if (response.length >= 3 && response[0] === NEGATIVE_RESP) {
    const nrc = response[2];
    return {
      ok: false,
      sid: response[1],
      nrc,
      name: NRC_NAMES[nrc] || `0x${nrc.toString(16).toUpperCase().padStart(2, '0')}`,
    };
  }

  if (response[0] === (reqSid | 0x40)) {
    return { ok: true, sid: reqSid, data: response.slice(1) };
  }

  return {
    ok: false,
    sid: response[0],
    nrc: -1,
    name: 'unexpectedResponse',
  };
}
