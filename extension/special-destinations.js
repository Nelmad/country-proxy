// URL literals and localhost names only: DNR cannot classify the IP returned by
// DNS for an arbitrary hostname. Chrome canonicalizes IP spellings before DNR.
// Keep these durable rules above both the probe exception and session admission.
// Separate small regexes stay below Chrome's 2 KiB compiled-memory limit; source
// length alone does not establish that limit (verify via isRegexSupported).
const HOSTS = [
  '([^/?#:@]*\\.)?localhost\\.?',
  '127\\.[0-9]+\\.[0-9]+\\.[0-9]+',
  '169\\.254\\.[0-9]+\\.[0-9]+',
  '0\\.0\\.0\\.0',
  '\\[(::|::1|::ffff:0:0)\\]',
  '\\[fe[89ab][0-9a-f]:[0-9a-f:]*\\]',
  '\\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\\]',
  '\\[::ffff:a9fe:[0-9a-f]{1,4}\\]'
];
export const SPECIAL_DESTINATION_PATTERNS = HOSTS.map(host =>
  '^(https?|wss?)://([^/@]*@)?' + host + '(:[0-9]+)?/');
export const SPECIAL_RULE_IDS = SPECIAL_DESTINATION_PATTERNS.flatMap((_, index) =>
  [710007 + index * 2, 710008 + index * 2]);
export function specialDestinationRules() {
  return SPECIAL_DESTINATION_PATTERNS.flatMap((regexFilter, index) =>
    [false, true].map(main => ({id: SPECIAL_RULE_IDS[index * 2 + Number(main)],
      priority: 4, action: {type: 'block'},
      condition: {regexFilter, ...(main ? {resourceTypes: ['main_frame']} : {})}})));
}
