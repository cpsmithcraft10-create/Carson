'use strict';

var form = document.getElementById('signin');
var flash = document.getElementById('flash');

function landing(user) {
  return user.role === 'office' ? '/office.html' : '/crew.html';
}

// Already signed in? Straight through.
api('/api/me', { bounceOnExpiry: false })
  .then(function (r) { location.replace(landing(r.user)); })
  .catch(function () { /* not signed in yet */ });

form.addEventListener('submit', function (event) {
  event.preventDefault();

  var button = form.querySelector('button');
  button.disabled = true;
  flashInto(flash, '');

  api('/api/signin', {
    method: 'POST',
    body: {
      username: document.getElementById('username').value,
      pin: document.getElementById('pin').value,
    },
  }).then(function (r) {
    location.replace(landing(r.user));
  }).catch(function (err) {
    flashInto(flash, err.message, 'bad');
    document.getElementById('pin').value = '';
    button.disabled = false;
  });
});
