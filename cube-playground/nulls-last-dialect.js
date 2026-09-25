/**
 * Descending sorts put empty values last.
 *
 * Postgres sorts NULL first in a descending order, and Cube renders an order
 * as `ORDER BY <column> DESC`. Every "latest" or "top" query over rows that
 * can be empty therefore led with the empty ones: "when did we last sell a
 * Trace" returned lines on quotes and open work orders (no completion date)
 * before any sale, three queries running, and an all-time "top items by
 * revenue" led with items that never sold. Cube's own default order (the
 * first measure, descending) does the same. Ascending sorts already put NULL
 * last in Postgres, so only DESC changes.
 *
 * Cube 1.7 renders ORDER BY in two places: the Tesseract planner (the default)
 * through the dialect's `order_by` SQL template, and the legacy planner (used
 * for pre-aggregation matching) through `orderHashToString`. `extendDialect`
 * subclasses Cube's Postgres dialect to change both; cube.js hands it to Cube
 * through `dialectFactory`. It refuses to load if either has moved, so a Cube
 * upgrade cannot silently drop the fix. Upstream: BaseQuery.sqlTemplates and
 * BaseQuery.orderHashToString.
 */
const NULLS_FIRST_CLAUSE = '{% if nulls_first %} NULLS FIRST{% endif %}';
const NULLS_CLAUSE = '{% if nulls_first %} NULLS FIRST{% elif not asc %} NULLS LAST{% endif %}';

/** The `order_by` template with empty values last on descending sorts. */
function nullsLastOrderBy(template) {
  return typeof template === 'string' && template.includes(NULLS_FIRST_CLAUSE)
    ? template.replace(NULLS_FIRST_CLAUSE, NULLS_CLAUSE)
    : template;
}

/** The source of the nearest definition of `method` up the class chain (for sqlTemplates, the one holding order_by). */
function definitionSource(Base, method) {
  for (let proto = Base && Base.prototype; proto; proto = Object.getPrototypeOf(proto)) {
    if (Object.prototype.hasOwnProperty.call(proto, method) && typeof proto[method] === 'function') {
      const source = Function.prototype.toString.call(proto[method]);
      if (method !== 'sqlTemplates' || source.includes('order_by:')) return source;
    }
  }
  return null;
}

function extendDialect(Base) {
  const orderHash = definitionSource(Base, 'orderHashToString');
  if (orderHash === null) {
    throw new Error('Albert Cube config: the Postgres dialect has no orderHashToString; review the nulls-last ordering before upgrading Cube.');
  }
  if (!/hash\.desc\s*\?\s*(['"])DESC\1\s*:\s*(['"])ASC\2/.test(orderHash)) {
    throw new Error('Albert Cube config: orderHashToString no longer renders the sort direction as expected; review the nulls-last ordering before upgrading Cube.');
  }
  const templates = definitionSource(Base, 'sqlTemplates');
  if (templates === null || !templates.includes(NULLS_FIRST_CLAUSE)) {
    throw new Error('Albert Cube config: the order_by SQL template no longer ends with the nulls_first clause; review the nulls-last ordering before upgrading Cube.');
  }
  return class NullsLastPostgresQuery extends Base {
    orderHashToString(hash) {
      const ordered = super.orderHashToString(hash);
      return ordered && hash && hash.desc ? `${ordered} NULLS LAST` : ordered;
    }

    sqlTemplates() {
      const sqlTemplates = super.sqlTemplates();
      if (sqlTemplates && sqlTemplates.expressions) {
        sqlTemplates.expressions.order_by = nullsLastOrderBy(sqlTemplates.expressions.order_by);
      }
      return sqlTemplates;
    }
  };
}

module.exports = { extendDialect, nullsLastOrderBy };
