import { NextFunction, Request, Response } from 'express';
import db from '../db';

async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const scopeClause = req.user?.role === 'admin' ? '' : ' AND user_id = $1';
    const scopeParams = req.user?.role === 'admin' ? [] : [req.user!.id];
    const scopedCompletedWhere = `WHERE status = 'completed'${scopeClause}`;

    const totalResult = await db.query(
      `SELECT COUNT(*) as count FROM assets ${scopedCompletedWhere}`,
      scopeParams,
    );
    const totalRow = totalResult.rows[0] as { count: string };
    const totalAssets = Number.parseInt(totalRow.count, 10);

    const downloadsResult = await db.query(
      `SELECT SUM(downloads) as total FROM assets ${scopedCompletedWhere}`,
      scopeParams,
    );
    const downloadsRow = downloadsResult.rows[0] as { total?: string | number | null };
    const totalDownloads = Number.parseInt(String(downloadsRow.total || 0), 10);

    const storageResult = await db.query(
      `SELECT SUM(size) as total FROM assets ${scopedCompletedWhere}`,
      scopeParams,
    );
    const storageRow = storageResult.rows[0] as { total?: string | number | null };
    const totalStorage = Number.parseInt(String(storageRow.total || 0), 10);

    const thisMonthResult = await db.query(
      `SELECT COUNT(*) as count FROM assets 
       ${scopedCompletedWhere}
       AND uploaded_at >= date_trunc('month', CURRENT_DATE)`,
      scopeParams,
    );
    const monthRow = thisMonthResult.rows[0] as { count: string };
    const assetsThisMonth = Number.parseInt(monthRow.count, 10);

    const typeResult = await db.query(
      `SELECT type, COUNT(*) as count 
       FROM assets 
       ${scopedCompletedWhere}
       GROUP BY type`,
      scopeParams,
    );
    const assetsByType: Record<string, number> = {};
    typeResult.rows.forEach((row: unknown) => {
      const typedRow = row as { type: string; count: string };
      assetsByType[typedRow.type] = Number.parseInt(typedRow.count, 10);
    });

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

export { getStats };
