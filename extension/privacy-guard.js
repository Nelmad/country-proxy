export class PrivacyControlError extends Error {
  constructor(name) { super('Chrome не подтвердил защитную настройку ' + name); }
}
export const PRIVACY_REQUIREMENTS = {
  webRTCIPHandlingPolicy: 'disable_non_proxied_udp', networkPredictionEnabled: false
};
export class PrivacyGuard {
  constructor(network) { this.network = network; }
  async verify() {
    await Promise.all(Object.entries(PRIVACY_REQUIREMENTS).map(async ([name, wanted]) => {
      const actual = await this.network[name].get({incognito: false});
      // Effective safe values satisfy the protection even under another owner.
      if (actual.value !== wanted) throw new PrivacyControlError(name);
    }));
  }
  async apply() {
    const results = await Promise.allSettled(Object.entries(PRIVACY_REQUIREMENTS).map(async ([name, wanted]) => {
      const setting = this.network[name], actual = await setting.get({incognito: false});
      if (actual.value === wanted && !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(actual.levelOfControl)) return;
      if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(actual.levelOfControl)) {
        throw new PrivacyControlError(name);
      }
      await setting.set({value: wanted, scope: 'regular'});
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw failures[0].reason;
    await this.verify(); // A successful set callback does not prove effectiveness.
  }
}
