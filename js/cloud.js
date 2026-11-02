(function () {
  'use strict';

  const config = window.LEXI_CONFIG || {};
  const enabled = Boolean(config.supabaseUrl && config.supabaseKey && window.supabase);
  const client = enabled
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseKey, { auth: { flowType: 'pkce' } })
    : null;

  async function check(request) {
    const { data, error } = await request;
    if (error) {
      throw error;
    }
    return data;
  }

  function toRow(set) {
    return {
      id: set.id,
      title: set.title,
      cards: set.cards,
      best_match: set.bestMatch ?? null,
      updated_at: new Date().toISOString(),
    };
  }

  function fromRow(row) {
    const set = { id: row.id, title: row.title, cards: row.cards || [] };
    if (row.best_match) {
      set.bestMatch = row.best_match;
    }
    return set;
  }

  window.LexiCloud = {
    enabled,

    onAuthChange(callback) {
      // Supabase calls made directly inside this listener can deadlock, so defer them.
      client.auth.onAuthStateChange((event, session) => {
        setTimeout(() => callback(session ? session.user : null), 0);
      });
    },

    async signIn(email) {
      await check(client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.origin + location.pathname },
      }));
    },

    async signOut() {
      await client.auth.signOut({ scope: 'local' });
    },

    async fetchSets() {
      const rows = await check(client.from('sets').select('id, title, cards, best_match').order('created_at'));
      return rows.map(fromRow);
    },

    async upsertSets(sets) {
      await check(client.from('sets').upsert(sets.map(toRow)));
    },

    async deleteSets(ids) {
      await check(client.from('sets').delete().in('id', ids));
    },
  };
})();
