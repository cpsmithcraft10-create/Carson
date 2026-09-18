'use strict';

const form = document.getElementById('login');
const msg = document.getElementById('msg');

function landingPage(user) {
  return user.role === 'admin' ? '/admin.html' : '/app.html';
}

// Already signed in? Skip straight through.
api('/api/me', { signInOnExpiry: false })
  .then(({ user }) => { location.replace(landingPage(user)); })
  .catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  say(msg, '');

  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: {
        username: document.getElementById('username').value,
        pin: document.getElementById('pin').value,
      },
    });
    location.replace(landingPage(user));
  } catch (err) {
    say(msg, err.message);
    document.getElementById('pin').value = '';
    button.disabled = false;
  }
});
