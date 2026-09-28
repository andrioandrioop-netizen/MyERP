/* MyERP – Supabase-backed sign-in
 *
 * This replaces the old localStorage prototype. Login is now by COLLEGE EMAIL
 * + PASSWORD (Supabase handles that part, so we don't touch passwords
 * ourselves). The short "ID" (like STU-83920) is still generated at sign-up
 * and shown on the profile as the person's official ID — it's just not what
 * they type in to log in.
 *
 * Before this works, fill in SUPABASE_URL and SUPABASE_ANON_KEY below
 * (Project Settings → API in your Supabase dashboard), and make sure every
 * page that includes this file also loads the Supabase library FIRST, e.g.:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
 *   <script src="myerp-auth.js"></script>
 *
 * Every function below returns a Promise (it has to — talking to Supabase is
 * always asynchronous), so call sites use .then(...) or `await`.
 */
(function (global) {
  'use strict';

  var SUPABASE_URL = 'https://ypbsiayocfeplujhuyyq.supabase.co';   // <-- fill in
  var SUPABASE_ANON_KEY = 'sb_publishable_5StrqEkfIiKpzNSrwGTlDQ_Wysr3qdz';               // <-- fill in

  var sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* Role-specific fields. [key in `details` jsonb, label shown on the profile page]
   * Add or remove rows here to change what a Student / Faculty account collects —
   * nothing else needs to change, the sign-up form reads this list too. */
  var ROLE_FIELDS = {
    Student: [
      ['course', 'Course'],
      ['specialization', 'Specialization'],
      ['semester', 'Semester'],
      ['batch', 'Batch'],
      ['parentName', "Parent's / guardian's name"],
      ['emergencyPhone', 'Emergency contact number'],
      ['permanentAddress', 'Permanent address']
    ],
    Faculty: [
      ['designation', 'Designation'],
      ['subjects', 'Subjects taught'],
      ['joined', 'Joined (year)']
    ],
    Admin: [] // Admin rows are created by hand in Supabase, see schema.sql
  };

  /* ---------- turn a `profiles` table row into what the pages expect ---------- */
  function toView(row) {
    var fields = ROLE_FIELDS[row.role] || [];
    var details = row.details || {};
    return {
      id: row.member_id,
      role: row.role,
      name: row.name,
      email: row.email,
      headline: row.headline || '',
      phone: row.phone || '',
      address: row.address || '',
      photo: row.photo || '',
      details: fields
        .filter(function (f) { return details[f[0]]; })
        .map(function (f) { return [f[1], details[f[0]]]; })
    };
  }

  /* ---------- error helpers ----------
   * supabase-js does NOT throw on network problems; it hands back an error
   * object. The old code turned every error into "wrong email or password",
   * which hid the real cause (offline, paused project, missing table...). */
  var NETWORK_MSG = "Can't reach the server. Check your internet connection. If that's fine, the Supabase project may be paused, or the URL / key in myerp-auth.js is wrong.";

  function isNetworkError(err) {
    if (!err) return false;
    var m = String(err.message || err).toLowerCase();
    return err.status === 0 || err.name === 'AuthRetryableFetchError' ||
      m.indexOf('failed to fetch') > -1 || m.indexOf('load failed') > -1 ||
      m.indexOf('networkerror') > -1 || m.indexOf('network request failed') > -1;
  }

  // -> { code, message }   code: 'network' | 'credentials' | 'unconfirmed' | 'rate' | 'error'
  function describeAuthError(err) {
    var m = String((err && err.message) || err || '');
    var c = (err && err.code) || '';
    if (isNetworkError(err)) return { code: 'network', message: NETWORK_MSG };
    if (c === 'email_not_confirmed' || /email not confirmed/i.test(m))
      return { code: 'unconfirmed', message: "Your email isn't confirmed yet. Open the confirmation link we emailed you, then sign in." };
    if (c === 'invalid_credentials' || /invalid login credentials/i.test(m))
      return { code: 'credentials', message: "That email or password doesn't match an account." };
    if (/rate limit|too many/i.test(m) || c === 'over_request_rate_limit' || c === 'over_email_send_rate_limit')
      return { code: 'rate', message: 'Too many attempts. Wait a minute and try again.' };
    return { code: 'error', message: m || 'Something went wrong. Please try again.' };
  }

  function describeProfileError(err) {
    if (isNetworkError(err)) return NETWORK_MSG;
    var m = String((err && err.message) || '');
    if (/could not find the table|does not exist|schema cache/i.test(m))
      return "Signed in, but the database isn't set up yet. Run schema.sql in the Supabase SQL Editor.";
    if (/permission denied|row-level security/i.test(m))
      return 'Signed in, but the database refused to load your profile (permissions). Re-run schema.sql / fix.sql in Supabase.';
    return "Signed in, but your profile couldn't be loaded. Run fix.sql in the Supabase SQL Editor, then try again. (" + (m || 'no profile row') + ')';
  }

  /* Returns { row } or { error }. If the profile row is missing (e.g. the
   * account was created before the trigger existed) it asks the database to
   * create it via the ensure_profile() function from fix.sql. */
  async function getProfile(userId) {
    var res = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (res.error) return { error: res.error };
    if (res.data) return { row: res.data };
    var ens = await sb.rpc('ensure_profile');
    if (!ens.error) {
      res = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (res.data) return { row: res.data };
    }
    return { error: ens.error || { message: 'no profile row' } };
  }

  async function sessionUser() {
    var r = await sb.auth.getSession();
    return r.data && r.data.session ? r.data.session.user : null;
  }

  /* Resolves { user } (account, or null when signed out) or { error }. */
  async function loadUser() {
    try {
      var su = await sessionUser();
      if (!su) return { user: null };
      var p = await getProfile(su.id);
      if (p.error) return { error: p.error };
      return { user: toView(p.row) };
    } catch (e) {
      return { error: e };
    }
  }

  function showLoadProblem(err) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:24px;background:#053d2d;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center';
    var inner = document.createElement('div');
    inner.style.maxWidth = '420px';
    var t = document.createElement('p');
    t.textContent = describeProfileError(err).replace(/^Signed in, but /, "We couldn't load your account: ");
    var b1 = document.createElement('button'); b1.textContent = 'Try again';
    var b2 = document.createElement('button'); b2.textContent = 'Back to sign in';
    [b1, b2].forEach(function (b) { b.style.cssText = 'margin:6px;padding:10px 20px;border-radius:999px;border:0;font:600 15px system-ui;cursor:pointer'; });
    b1.onclick = function () { global.location.reload(); };
    b2.onclick = function () { sb.auth.signOut().finally(function () { global.location.href = 'myerp-login.html'; }); };
    inner.appendChild(t); inner.appendChild(b1); inner.appendChild(b2); box.appendChild(inner);
    document.body.appendChild(box);
    document.body.classList.remove('checking');
  }

  async function updatePassword(next) {
    var res = await sb.auth.updateUser({ password: next });
    if (!res.error) return 'ok';
    var m = String(res.error.message || '');
    if (isNetworkError(res.error)) return 'network';
    if (res.error.code === 'same_password' || /different from the old/i.test(m)) return 'same';
    if (res.error.code === 'weak_password' || /at least|weak|characters/i.test(m)) return 'weak';
    return 'storage';
  }

  /* ---------- public API ---------- */
  var MyERP = {
    /* List of [key,label] fields to render for a role's sign-up form / profile. */
    fieldsFor: function (role) { return ROLE_FIELDS[role] || []; },

    /* Create a new Student or Faculty account.
     * Resolves to { ok:true, id }, { ok:true, id:null, needsConfirmation:true },
     * or { ok:false, message }. */
    signUp: async function (role, email, password, fields) {
      if (role === 'Admin') {
        return { ok: false, message: 'Admin accounts are created by the college office, not signed up here.' };
      }
      try {
        var details = {};
        (ROLE_FIELDS[role] || []).forEach(function (f) {
          if (fields[f[0]]) details[f[0]] = fields[f[0]];
        });

        var signUpRes = await sb.auth.signUp({
          email: String(email).trim().toLowerCase(),
          password: password,
          options: {
            data: {
              role: role,
              name: fields.name,
              headline: fields.headline || '',
              phone: fields.phone || '',
              address: fields.address || '',
              details: details
            }
          }
        });
        if (signUpRes.error) return { ok: false, message: describeAuthError(signUpRes.error).message };

        var userId = signUpRes.data.user && signUpRes.data.user.id;
        if (!userId) return { ok: false, message: 'Something went wrong creating the account. Try again.' };

        // Supabase returns a fake user (no identities) for an email that is already registered.
        var ids = signUpRes.data.user.identities;
        if (ids && ids.length === 0) return { ok: false, message: 'An account with this email already exists. Try signing in.' };

        if (!signUpRes.data.session) return { ok: true, id: null, needsConfirmation: true };

        var p = await getProfile(userId);
        return { ok: true, id: p.row ? p.row.member_id : null };
      } catch (e) {
        return { ok: false, message: describeAuthError(e).message };
      }
    },

    /* Resolves to { ok:true, user } or { ok:false, code, message }. */
    signIn: async function (email, password) {
      try {
        var res = await sb.auth.signInWithPassword({
          email: String(email).trim().toLowerCase(),
          password: password
        });
        if (res.error || !res.data || !res.data.user) {
          var d = describeAuthError(res.error);
          return { ok: false, code: d.code, message: d.message };
        }
        var p = await getProfile(res.data.user.id);
        if (p.error) {
          await sb.auth.signOut();
          return { ok: false, code: 'profile', message: describeProfileError(p.error) };
        }
        return { ok: true, user: toView(p.row) };
      } catch (e) {
        var d2 = describeAuthError(e);
        return { ok: false, code: d2.code, message: d2.message };
      }
    },

    signOut: async function () { try { await sb.auth.signOut(); } catch (e) {} },

    /* The signed-in account, or null. */
    currentUser: async function () {
      var r = await loadUser();
      return r.user || null;
    },

    /* Save phone / address / photo. Resolves to true only when the database
     * confirms the row was really updated (the old version said "saved" even
     * when nothing was written, so the picture vanished on reload).
     * On failure, MyERP.lastError holds the reason. */
    lastError: '',
    saveProfile: async function (patch) {
      MyERP.lastError = '';
      try {
        var su = await sessionUser();
        if (!su) { MyERP.lastError = 'You are signed out. Sign in again.'; return false; }
        var update = {};
        ['phone', 'address', 'photo'].forEach(function (k) {
          if (patch[k] !== undefined) update[k] = patch[k];
        });
        var res = await sb.from('profiles').update(update).eq('id', su.id).select('id');
        if (res.error) {
          MyERP.lastError = isNetworkError(res.error) ? NETWORK_MSG : res.error.message;
          return false;
        }
        if (!res.data || !res.data.length) {
          MyERP.lastError = 'No profile row was updated. Run fix.sql in Supabase, then try again.';
          return false;
        }
        return true;
      } catch (e) {
        MyERP.lastError = isNetworkError(e) ? NETWORK_MSG : String(e.message || e);
        return false;
      }
    },

    /* Change password while signed in.
     * Resolves to 'ok' | 'wrong' (current password incorrect) | 'network' |
     * 'same' (new = old) | 'weak' (rejected as too weak/short) | 'storage'. */
    changePassword: async function (current, next) {
      try {
        var su = await sessionUser();
        if (!su) return 'wrong';

        // Supabase has no "verify current password" call, so confirm it by signing in with it.
        var verify = await sb.auth.signInWithPassword({ email: su.email, password: current });
        if (verify.error) return isNetworkError(verify.error) ? 'network' : 'wrong';

        return await updatePassword(next);
      } catch (e) {
        return isNetworkError(e) ? 'network' : 'storage';
      }
    },

    /* ---------- forgot password ---------- */

    /* Emails a reset link that comes back to THIS page (the login page).
     * Resolves { ok:true } or { ok:false, message }.
     * The page's address must be listed under Supabase -> Authentication ->
     * URL Configuration -> Redirect URLs, and the page must be served over
     * http(s): a double-clicked file:// page can't receive the link. */
    requestPasswordReset: async function (email) {
      if (global.location.protocol === 'file:') {
        return { ok: false, message: 'Password reset emails only work when the site is opened from a web address (http/https or localhost), not as a local file.' };
      }
      try {
        var redirectTo = global.location.origin + global.location.pathname;
        var res = await sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo: redirectTo });
        if (res.error) return { ok: false, message: describeAuthError(res.error).message };
        return { ok: true };
      } catch (e) {
        return { ok: false, message: describeAuthError(e).message };
      }
    },

    /* True when this page was opened from a reset-password email link. */
    isRecoveryLink: function () {
      return /(^|[#&?])type=recovery/.test(global.location.hash + '&' + global.location.search);
    },

    /* A readable message when the emailed link was expired / already used, else ''. */
    linkError: function () {
      var h = global.location.hash + '&' + global.location.search;
      if (!/error_description=|error_code=/.test(h)) return '';
      if (/otp_expired|expired|invalid/i.test(h)) return 'That reset link has expired or was already used. Request a new one below.';
      return 'That link could not be used. Request a new one below.';
    },

    /* cb() fires once a reset link has been verified and a session exists. */
    onPasswordRecovery: function (cb) {
      sb.auth.onAuthStateChange(function (event) { if (event === 'PASSWORD_RECOVERY') cb(); });
    },

    /* Sets a new password after a reset link.
     * Resolves 'ok' | 'expired' | 'network' | 'same' | 'weak' | 'storage'. */
    setNewPassword: async function (next) {
      try {
        var su = await sessionUser();
        if (!su) return 'expired';
        return await updatePassword(next);
      } catch (e) {
        return isNetworkError(e) ? 'network' : 'storage';
      }
    },

    /* For module pages. Call it in <head>, before anything else.
     * Not signed in  -> back to the login page.
     * Role not in the optional list -> back to the profile page.
     * Couldn't reach the server -> an error screen with "Try again" (not a blank page).
     * Resolves to the signed-in account, or null when it is redirecting. */
    requireLogin: async function (roles) {
      var r = await loadUser();
      if (r.error) {
        var show = function () { showLoadProblem(r.error); };
        if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
        return null;
      }
      var u = r.user;
      if (!u) { global.location.replace('myerp-login.html'); return null; }
      if (roles && roles.indexOf(u.role) < 0) { global.location.replace('myerp-profile.html'); return null; }
      return u;
    },

    /* For module pages. Adds a small "who am I" pill to the end of a header bar;
     * tapping it opens the profile page. Pass a selector or an element. */
    mountAccount: async function (target) {
      var u = await MyERP.currentUser();
      var bar = typeof target === 'string' ? document.querySelector(target) : target;
      if (!u || !bar) return;

      if (!document.getElementById('myerp-chip-css')) {
        var st = document.createElement('style');
        st.id = 'myerp-chip-css';
        st.textContent =
          '.myerp-chip{display:inline-flex;align-items:center;gap:8px;flex:none;padding:4px 14px 4px 4px;' +
          'border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);' +
          'color:#fff;text-decoration:none;font:600 13px/1 system-ui,sans-serif;white-space:nowrap}' +
          '.myerp-chip:hover{background:rgba(255,255,255,.26)}' +
          '.myerp-chip:focus-visible{outline:3px solid #fff;outline-offset:2px}' +
          '.myerp-chip i{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;overflow:hidden;' +
          'background:#053d2d;font-style:normal;font-weight:800;font-size:12px}' +
          '.myerp-chip img{width:100%;height:100%;object-fit:cover}' +
          '@media (max-width:640px){.myerp-chip{padding-right:4px}.myerp-chip span{display:none}}';
        document.head.appendChild(st);
      }

      var a = document.createElement('a');
      a.className = 'myerp-chip';
      a.href = 'myerp-profile.html';
      a.title = 'Open your profile';
      a.setAttribute('aria-label', 'Your profile: ' + u.name);

      var av = document.createElement('i');
      if (u.photo) {
        var im = document.createElement('img'); im.src = u.photo; im.alt = ''; av.appendChild(im);
      } else {
        av.textContent = u.name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).slice(0, 2)
          .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
      }
      var nm = document.createElement('span');
      nm.textContent = u.name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/)[0];

      a.appendChild(av); a.appendChild(nm);
      bar.appendChild(a);
    }
  };

  global.MyERP = MyERP;
})(window);
