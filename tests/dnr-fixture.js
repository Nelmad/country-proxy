// In-memory Chrome DNR adapter for lifecycle tests. Browser matching is separately
// exercised in Chrome for Testing; this fixture models only atomic rule commits.
export function dnrFixture({dynamic = [], session = [], reject = () => false} = {}) {
  const state = {dynamic: structuredClone(dynamic), session: structuredClone(session), calls: []};
  const update = async (kind, changes) => {
    state.calls.push({kind, changes: structuredClone(changes)});
    if (reject(kind, changes)) throw Error('DNR commit rejected: ' + kind);
    const retained = state[kind].filter(rule => !(changes.removeRuleIds || []).includes(rule.id));
    state[kind] = [...retained, ...structuredClone(changes.addRules || [])];
  };
  return {state, api: {
    getDynamicRules: async () => structuredClone(state.dynamic),
    getSessionRules: async () => structuredClone(state.session),
    updateDynamicRules: changes => update('dynamic', changes),
    updateSessionRules: changes => update('session', changes)
  }};
}
