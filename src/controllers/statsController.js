const db = require('../db');

async function getStats(req, res, next) {
  try {
    const scopeClause = req.user?.role === 'admin' ? '' : ' AND user_id = $1';
    const scopeParams = req.user?.role === 'admin' ? [] : [req.user.id];
    const scopedCompletedWhere = `WHERE status = 'completed'${scopeClause}`;

    // Total assets
    const totalResult = await db.query(
      `SELECT COUNT(*) as count FROM assets ${scopedCompletedWhere}`,
      scopeParams,
    );
    const totalAssets = parseInt(totalResult.rows[0].count);

    // Total downloads
    const downloadsResult = await db.query(
      `SELECT SUM(downloads) as total FROM assets ${scopedCompletedWhere}`,
      scopeParams,
    );
    const totalDownloads = parseInt(downloadsResult.rows[0].total || 0);

    // Total storage
    const storageResult = await db.query(
      `SELECT SUM(size) as total FROM assets ${scopedCompletedWhere}`,
      scopeParams,
    );
    const totalStorage = parseInt(storageResult.rows[0].total || 0);

    // Assets this month
    const thisMonthResult = await db.query(
      `SELECT COUNT(*) as count FROM assets 
       ${scopedCompletedWhere}
       AND uploaded_at >= date_trunc('month', CURRENT_DATE)`,
      scopeParams,
    );
    const assetsThisMonth = parseInt(thisMonthResult.rows[0].count);

    // Asset type distribution
    const typeResult = await db.query(
      `SELECT type, COUNT(*) as count 
       FROM assets 
       ${scopedCompletedWhere}
       GROUP BY type`,
      scopeParams,
    );
    const assetsByType = {};
    typeResult.rows.forEach((row) => {
      assetsByType[row.type] = parseInt(row.count);
    });

    // Most downloaded assets
    const topResult = await db.query(
      `SELECT * FROM assets 
       ${scopedCompletedWhere}
       ORDER BY downloads DESC 
       LIMIT 5`,
      scopeParams,
    );

    res.json({
      totalAssets,
      totalDownloads,
      totalStorage,
      assetsThisMonth,
      assetsByType,
      topDownloaded: topResult.rows,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getStats,
};
