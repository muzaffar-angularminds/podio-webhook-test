const API = '/admin/api/apps';

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 2500);
}

function maskToken(token) {
  if (!token) return '-';
  return token.substring(0, 6) + '...' + token.substring(token.length - 4);
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

function escapeHtml(str) {
  if (!str) return '-';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

async function loadApps() {
  var res = await fetch(API);
  var apps = await res.json();
  var container = document.getElementById('appList');

  if (apps.length === 0) {
    container.innerHTML = '<div class="empty">No apps registered yet.</div>';
    return;
  }

  var thead = '<table><thead><tr>'
    + '<th>App ID</th><th>Name</th><th>Token</th><th>Space ID</th>'
    + '<th>Status</th><th>Last Seeded</th><th>Actions</th>'
    + '</tr></thead><tbody>';

  var rows = apps.map(function(app) {
    var badgeClass = app.isActive ? 'badge-active' : 'badge-inactive';
    var badgeText = app.isActive ? 'Active' : 'Inactive';
    var toggleClass = app.isActive ? 'btn-warning' : 'btn-success';
    var toggleText = app.isActive ? 'Deactivate' : 'Activate';

    return '<tr>'
      + '<td><strong>' + app.appId + '</strong></td>'
      + '<td>' + escapeHtml(app.appName) + '</td>'
      + '<td><span class="token-mask">' + maskToken(app.appToken) + '</span></td>'
      + '<td>' + (app.spaceId || '-') + '</td>'
      + '<td><span class="badge ' + badgeClass + '">' + badgeText + '</span></td>'
      + '<td>' + formatDate(app.lastSeededAt) + '</td>'
      + '<td><div class="actions">'
      + '<button class="btn btn-sm ' + toggleClass + '" data-action="toggle" data-appid="' + app.appId + '">' + toggleText + '</button>'
      + '<button class="btn btn-sm btn-danger" data-action="delete" data-appid="' + app.appId + '">Delete</button>'
      + '</div></td>'
      + '</tr>';
  }).join('');

  container.innerHTML = thead + rows + '</tbody></table>';
}

async function toggleApp(appId) {
  try {
    var res = await fetch(API + '/' + appId + '/toggle', { method: 'PATCH' });
    if (res.ok) {
      var app = await res.json();
      toast('App ' + appId + (app.isActive ? ' activated' : ' deactivated'));
    } else {
      var err = await res.json().catch(function() { return {}; });
      toast(err.message || 'Toggle failed: ' + res.status);
    }
  } catch (e) {
    toast('Toggle error: ' + e.message);
  }
  loadApps();
}

async function deleteApp(appId) {
  if (!confirm('Delete app ' + appId + '? This cannot be undone.')) return;
  try {
    var res = await fetch(API + '/' + appId, { method: 'DELETE' });
    if (res.ok) {
      toast('App ' + appId + ' deleted');
    } else {
      var err = await res.json().catch(function() { return {}; });
      toast(err.message || 'Delete failed: ' + res.status);
    }
  } catch (e) {
    toast('Delete error: ' + e.message);
  }
  loadApps();
}

// Event delegation for toggle/delete buttons
document.getElementById('appList').addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var action = btn.getAttribute('data-action');
  var appId = btn.getAttribute('data-appid');
  if (action === 'toggle') toggleApp(appId);
  if (action === 'delete') deleteApp(appId);
});

// Form submit
document.getElementById('addForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var body = {
    appId: document.getElementById('appId').value,
    appToken: document.getElementById('appToken').value,
    appName: document.getElementById('appName').value,
    spaceId: document.getElementById('spaceId').value,
  };

  var res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    toast('App registered successfully');
    document.getElementById('addForm').reset();
    loadApps();
  } else {
    var err = await res.json();
    toast(err.message || 'Failed to register app');
  }
});

loadApps();
