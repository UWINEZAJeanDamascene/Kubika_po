'use strict';

module.exports = {
  ...require('./RecommendationEngine'),
  ...require('./recommendationFactory'),
  ...require('./recommendationTypes'),
  ...require('./scoring'),
};
