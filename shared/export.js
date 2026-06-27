/* global self, ScraperConstants, __scraperDefine */
(function initExport() {
  const root = typeof globalThis !== 'undefined' ? globalThis : self;

  if (!root.__scraperDefine) {
    root.__scraperDefine = function (name, factory) {
      if (root[name]) return root[name];
      root[name] = factory();
      return root[name];
    };
  }

  root.__scraperDefine('ScraperExport', () => {
  const STREAM_CHUNK = 500;

  function escapeCsvCell(value) {
    const str = String(value ?? '');
    if (/[\n\r",]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function downloadText(filename, text, mimeType) {
    downloadBlob(filename, new Blob([text], { type: mimeType || 'text/plain;charset=utf-8' }));
  }

  function recordsToRows(records, scraperType) {
    if (!records.length) return { headers: [], rows: [] };

    if (scraperType === ScraperConstants.SCRAPER_MAPS) {
      const headers = [
        'Business Name', 'Category', 'Address',
        'Phone', 'Website', 'Business Hours', 'Email', 'Google Maps URL',
        'Collected At'
      ];
      const rows = records.map((r) => [
        r.name, r.category, r.address,
        r.phone, r.website, r.hours, r.email, r.url,
        new Date(r.timestamp || Date.now()).toISOString()
      ]);
      return { headers, rows };
    }

    const headers = [
      'Full Name', 'Job Title', 'Company', 'LinkedIn URL',
      'Email', 'Phone', 'Location', 'Industry', 'Collected At'
    ];
    const rows = records.map((r) => [
      r.name, r.title, r.company, r.url,
      r.email, r.phone, r.location, r.industry,
      new Date(r.timestamp || Date.now()).toISOString()
    ]);
    return { headers, rows };
  }

  function toCsvStreaming(records, scraperType) {
    const { headers, rows } = recordsToRows(records, scraperType);
    const parts = [headers.map(escapeCsvCell).join(',') + '\n'];

    for (let i = 0; i < rows.length; i += STREAM_CHUNK) {
      const chunk = rows.slice(i, i + STREAM_CHUNK);
      parts.push(chunk.map((row) => row.map(escapeCsvCell).join(',')).join('\n'));
      if (i + STREAM_CHUNK < rows.length) parts.push('\n');
    }
    return parts.join('\n');
  }

  function toCsv(records, scraperType) {
    return toCsvStreaming(records, scraperType);
  }

  function toJson(records, scraperType) {
    if (records.length <= 2000) {
      return JSON.stringify({ scraperType, count: records.length, records }, null, 2);
    }
    return JSON.stringify({ scraperType, count: records.length, records });
  }

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toExcelXml(records, scraperType) {
    const { headers, rows } = recordsToRows(records, scraperType);
    const headerCells = headers.map((h) => `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('');

    let dataRows = '';
    for (let i = 0; i < rows.length; i += STREAM_CHUNK) {
      const chunk = rows.slice(i, i + STREAM_CHUNK);
      dataRows += chunk.map((row) => {
        const cells = row.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>`).join('');
        return `<Row>${cells}</Row>`;
      }).join('');
    }

    return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Data">
<Table>
<Row>${headerCells}</Row>
${dataRows}
</Table>
</Worksheet>
</Workbook>`;
  }

  function exportRecords(records, scraperType, format) {
    const date = new Date().toISOString().slice(0, 10);
    const prefix = scraperType === ScraperConstants.SCRAPER_MAPS ? 'google-maps' : 'linkedin-leads';

    if (format === 'json') {
      downloadText(`${prefix}-${date}.json`, toJson(records, scraperType), 'application/json;charset=utf-8');
      return;
    }
    if (format === 'excel') {
      downloadText(`${prefix}-${date}.xls`, toExcelXml(records, scraperType), 'application/vnd.ms-excel;charset=utf-8');
      return;
    }
    downloadText(`${prefix}-${date}.csv`, toCsvStreaming(records, scraperType), 'text/csv;charset=utf-8');
  }

  return {
    escapeCsvCell, downloadText, toCsv, toJson, toExcelXml,
    exportRecords, recordsToRows, toCsvStreaming
  };
  });
})();
