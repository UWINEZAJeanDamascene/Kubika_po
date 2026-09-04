/**
 * Cross-user cache-invalidation signal.
 *
 * A write in one browser tab must not leave every other tab/user viewing the
 * same company's transfers, purchases, orders, GRNs, delivery notes,
 * quotations, credit notes, or pick-packs showing a status/quantity that
 * has already changed. `emitDataChanged` fires a best-effort socket event
 * after a commit so the frontend's realtime-sync hook can invalidate the
 * matching React Query root key without polling.
 *
 * This must never throw or delay the HTTP response it rides on:
 * `socketService.emitToCompany` already swallows its own errors, and this
 * wrapper adds a second guard in case socket.io is not initialized (tests,
 * workers without a socket server) or `companyId`/`domain` is missing.
 */

const socketService = require('../services/socketService');

/**
 * @param {string} companyId
 * @param {string} domain - matches a frontend root query key, e.g. 'transfers', 'purchases', 'purchaseOrders', 'grn', 'deliveryNotes', 'quotations', 'creditNotes', 'pickPacks'
 * @param {{ affectsStock?: boolean }} [options] - also signal 'stock:changed' when the write commits/reverses inventory
 */
function emitDataChanged(companyId, domain, options = {}) {
  if (!companyId || !domain) return;
  try {
    socketService.emitToCompany(String(companyId), 'orders:changed', { domain });
    if (options.affectsStock) {
      socketService.emitToCompany(String(companyId), 'stock:changed', { domain });
    }
  } catch (_err) {
    // A best-effort realtime signal must never break the request it rides on.
  }
}

module.exports = { emitDataChanged };
