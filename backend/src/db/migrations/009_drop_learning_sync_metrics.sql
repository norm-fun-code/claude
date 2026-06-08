-- Books/Highlights/Notion were never meant to be tracked as metrics — the
-- Readwise and Notion connectors only exist to feed the Wisdom/quotes features.
-- Their connectors used to write cumulative counts (e.g. 17k highlights, 165
-- books, 3460 Notion pages) as single data points, which the intelligence layer
-- read as a -99%/-100% "trend" and a multi-sigma anomaly, polluting the Insights
-- tab and Highest-Leverage actions.
--
-- The connectors no longer write these (they return metrics:[]), but the
-- historical rows persist and analyze() keys off whatever is in the table, so
-- the bad findings keep regenerating until the rows are gone. Drop them.
DELETE FROM metrics
 WHERE domain = 'learning'
   AND metric IN ('books_synced', 'highlights_synced', 'notion_pages', 'notion_pages_synced');
