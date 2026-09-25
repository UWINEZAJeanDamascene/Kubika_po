const userRoutes = require('../routes/userRoutes');

describe('user invite route registration', () => {
  it('registers /invite before the generic /:id route so invite requests hit the correct controller', () => {
    const routes = userRoutes.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);

    const inviteIndex = routes.indexOf('/invite');
    const idIndex = routes.indexOf('/:id');

    expect(inviteIndex).toBeGreaterThan(-1);
    expect(idIndex).toBeGreaterThan(-1);
    expect(inviteIndex).toBeLessThan(idIndex);
  });
});
