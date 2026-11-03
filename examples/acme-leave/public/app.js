/* Acme Leave front end: plain DOM, no framework. */
(function () {
  const $ = (s) => document.querySelector(s);
  let me = null;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function cell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function button(label, testid, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.testid = testid;
    b.addEventListener('click', onClick);
    return b;
  }

  function show(view) {
    for (const id of ['login-view', 'mine-view', 'team-view']) $('#' + id).hidden = id !== view;
  }

  async function renderMine() {
    const [bal, list] = await Promise.all([api('GET', '/api/balance'), api('GET', '/api/requests')]);
    $('#bal-year').textContent = bal.year;
    $('#bal-remaining').textContent = bal.remaining;
    $('#bal-entitlement').textContent = bal.entitlement;
    $('#bal-used').textContent = bal.used;
    const tbody = $('[data-testid="my-requests"] tbody');
    tbody.replaceChildren();
    for (const r of list) {
      const tr = document.createElement('tr');
      tr.dataset.requestId = r.id;
      tr.append(cell(r.start_date), cell(r.end_date), cell(r.days), cell(r.reason), cell(r.status));
      const actions = document.createElement('td');
      if (r.status === 'pending') actions.append(button('Cancel', 'cancel', () => decide(r.id, 'cancel')));
      tr.append(actions);
      tbody.append(tr);
    }
  }

  async function renderTeam() {
    const list = await api('GET', '/api/team/requests');
    const tbody = $('[data-testid="team-requests"] tbody');
    tbody.replaceChildren();
    for (const r of list) {
      const tr = document.createElement('tr');
      tr.dataset.requestId = r.id;
      tr.append(cell(r.user_name), cell(r.start_date), cell(r.end_date), cell(r.days), cell(r.status));
      const actions = document.createElement('td');
      if (r.status === 'pending' && r.user_id !== me.id) {
        actions.append(button('Approve', 'approve', () => decide(r.id, 'approve')), button('Reject', 'reject', () => decide(r.id, 'reject')));
      }
      tr.append(actions);
      tbody.append(tr);
    }
  }

  async function decide(id, action) {
    try {
      await api('POST', `/api/requests/${id}/${action}`);
    } catch (err) {
      alert(err.message);
    }
    route();
  }

  async function route() {
    try {
      me = await api('GET', '/api/me');
    } catch {
      me = null;
    }
    $('#nav').hidden = !me;
    $('#logout').hidden = !me;
    $('#who').textContent = me ? `${me.name} (${me.role})` : '';
    if (!me) return show('login-view');
    $('#nav-team').hidden = me.role !== 'manager';
    if (location.hash === '#team' && me.role === 'manager') {
      show('team-view');
      return renderTeam();
    }
    show('mine-view');
    return renderMine();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
      $('#login-error').textContent = '';
      route();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/requests', { start: f.get('start'), end: f.get('end'), reason: f.get('reason') });
      $('#request-error').textContent = '';
      e.target.reset();
      route();
    } catch (err) {
      $('#request-error').textContent = err.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    route();
  });

  window.addEventListener('hashchange', route);
  route();
})();
