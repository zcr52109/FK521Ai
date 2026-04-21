function makeStrategy(name) {
  return {
    name,
    authenticate() {
      this.success?.({ id: 'mock-user' });
    },
  };
}

function jwtLogin() {
  return makeStrategy('jwt');
}

function passportLogin() {
  return makeStrategy('local');
}

const ldapLogin = makeStrategy('ldap');

module.exports = { jwtLogin, passportLogin, ldapLogin };
