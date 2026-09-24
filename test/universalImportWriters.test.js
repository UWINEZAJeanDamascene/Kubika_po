const { listEntityDefinitions } = require('../services/importDefinitions');
const { PROCESSABLE_ENTITY_TYPES } = require('../services/universalImportService');

describe('universal import writer coverage', () => {
  test('every advertised entity has a process writer', () => {
    const entityTypes = listEntityDefinitions().map((entity) => entity.key);
    expect(entityTypes).toEqual(expect.arrayContaining([...PROCESSABLE_ENTITY_TYPES]));
    expect(PROCESSABLE_ENTITY_TYPES.size).toBe(entityTypes.length);
  });
});
