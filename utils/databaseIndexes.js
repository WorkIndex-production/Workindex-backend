const Rating = require('../models/Rating');

function isExpectedPartial(index, field) {
  return Boolean(
    index &&
    index.unique &&
    index.partialFilterExpression &&
    index.partialFilterExpression[field] &&
    index.partialFilterExpression[field].$type === 'objectId'
  );
}

async function ensureRatingIndexes() {
  const collection = Rating.collection;
  let indexes = await collection.indexes();

  for (const field of ['approach', 'invite']) {
    const indexName = `${field}_1`;
    const existing = indexes.find(idx => idx.name === indexName);
    if (existing && !isExpectedPartial(existing, field)) {
      await collection.dropIndex(indexName);
      indexes = await collection.indexes();
    }

    const hasExpected = indexes.some(idx => idx.name === indexName && isExpectedPartial(idx, field));
    if (!hasExpected) {
      await collection.createIndex(
        { [field]: 1 },
        {
          name: indexName,
          unique: true,
          partialFilterExpression: { [field]: { $type: 'objectId' } }
        }
      );
      indexes = await collection.indexes();
    }
  }
}

module.exports = { ensureRatingIndexes };
