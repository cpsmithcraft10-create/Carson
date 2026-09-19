'use strict';

var form = document.getElementById('signin');
var notice = document.getElementById('notice');

function landing(user) {
  return user.role === 'admin' ? '/office.html' : '/app.html';
}

// Already signed in? Go straight through.
api('/api/me', { signInOnExpiry: false })
  .then(function (r) { location.replace(landing(r.user)); })
  .catch(function () { /* not signed in yet */ });

form.addEventListener('submit', function (event) {
  event.preventDefault();

  var button = form.querySelector('button');
  button.disabled = true;
  say(notice, '');

  api('/api/login', {
    method: 'POST',
    body: {
      username: document.getElementById('username').value,
      pin: document.getElementById('pin').value
    }
  }).then(function (r) {
    location.replace(landing(r.user));
  }).catch(function (err) {
    say(notice, err.message, 'bad');
    document.getElementById('pin').value = '';
    button.disabled = false;
  });
});
