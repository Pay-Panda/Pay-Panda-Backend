const strongPasswordPattern = /^\S{6,100}$/;

function isStrongPassword(password) {
  return strongPasswordPattern.test(password);
}

const passwordMessage = 'Password must be at least 6 characters and cannot contain spaces.';

module.exports = { isStrongPassword, passwordMessage, strongPasswordPattern };
