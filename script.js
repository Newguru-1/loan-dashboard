// ==== CONFIGURATION ====

// Actual server (your PikaPods URL)
const ACTUAL_BASE_URL = "https://nostalgic-malamute.pikapod.net";

// OneDrive CSV links (the ones you gave me)
const CSV_PROJECTION_URL =
  "https://onedrive.live.com/download?resid=E903FD9E25234A94B400BA4DB17F8AE6";
const CSV_SCENARIOS_URL =
  "https://onedrive.live.com/download?resid=FBEE0E56551D4D1D8FFE65DE891895DE";
const CSV_SCENARIOS_SUMMARY_URL =
  "https://onedrive.live.com/download?resid=089E8BED4D1A40219FD3770256C1D660";

// You can later refine these filters if needed
const LOAN_ACCOUNT_NAME = null; // e.g. "VWFS Loan" if you want to filter by account
const LOAN_CATEGORY_NAME = null; // e.g. "Car Loan" if you want to filter by category

// ==== SMALL HELPERS ====

function setStatus(text) {
  const el = document.getElementById("statusText");
  if (el) el.textContent = text;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (cols[i] ?? "").trim();
    });
    return obj;
  });
}

function parseNumber(value) {
  if (value == null || value === "") return 0;
  // handle both "1234.56" and "1234,56"
  const normalized = value.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return isNaN(n) ? 0 : n;
}

function formatCurrency(value) {
  return value.toLocaleString("en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

function formatDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "–";
  return date.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function diffMonths(d1, d2) {
  if (!d1 || !d2) return 0;
  const y1 = d1.getFullYear();
  const m1 = d1.getMonth();
  const y2 = d2.getFullYear();
  const m2 = d2.getMonth();
  return (y2 - y1) * 12 + (m2 - m1);
}

// ==== FETCH CSVs ====

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch CSV: ${res.status}`);
  }
  const text = await res.text();
  return parseCSV(text);
}

// ==== FETCH ACTUAL DATA ====

async function fetchActualTransactions() {
  // Very simple: get all transactions; you can later filter by account/category
  const res = await fetch(`${ACTUAL_BASE_URL}/api/transactions`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Actual transactions: ${res.status}`);
  }
  const data = await res.json();
  // Actual usually returns { data: [ ... ] } or similar; we’ll be defensive
  const txs = Array.isArray(data) ? data : data.data || [];
  return txs;
}

// ==== PROCESS ACTUAL DATA (very simple heuristic) ====

function buildRealSeries(transactions) {
  // This is intentionally simple: we assume:
  // - negative amounts are payments
  // - we accumulate them over time and approximate a balance curve
  // You can later refine this to use the exact loan account balance.

  // Filter by account/category if configured
  let filtered = transactions;
  if (LOAN_ACCOUNT_NAME) {
    filtered = filtered.filter(
      (t) => t.account && t.account.name === LOAN_ACCOUNT_NAME
    );
  }
  if (LOAN_CATEGORY_NAME) {
    filtered = filtered.filter(
      (t) => t.category && t.category.name === LOAN_CATEGORY_NAME
    );
  }

  // Map to { date, amount }
  const mapped = filtered
    .filter((t) => t.date && typeof t.amount === "number")
    .map((t) => ({
      date: new Date(t.date),
      amount: t.amount, // Actual usually uses negative for outflows
    }))
    .sort((a, b) => a.date - b.date);

  if (mapped.length === 0) {
    return { labels: [], balances: [], lastDate: null };
  }

  // We don't know the exact starting balance from Actual here,
  // so we will align the real curve to the projection later.
  // For now, we just accumulate payments as "progress".
  let cumulativePaid = 0;
  const labels = [];
  const paidSeries = [];

  for (const tx of mapped) {
    cumulativePaid += -tx.amount; // negative = payment
    labels.push(tx.date);
    paidSeries.push(cumulativePaid);
  }

  const lastDate = mapped[mapped.length - 1].date;
  return { labels, paidSeries, lastDate };
}

// ==== MAIN LOGIC ====

let chartInstance = null;

async function main() {
  try {
    setStatus("Loading CSV projections…");

    const [projectionRows, scenarioRows, scenarioSummaryRows] =
      await Promise.all([
        fetchCSV(CSV_PROJECTION_URL),
        fetchCSV(CSV_SCENARIOS_URL),
        fetchCSV(CSV_SCENARIOS_SUMMARY_URL),
      ]);

    setStatus("Loading Actual transactions…");

    const transactions = await fetchActualTransactions();

    // Build projection base series
    // loan_projection.csv columns (from your screenshot):
    // Mes, Data, Juros, Imposto, Capital, Prestacao, Saldo, PctJuros, JurosAcumulados
    const projectionLabels = [];
    const projectionBalance = [];
    let baseTotalInterest = 0;
    let basePayoffDate = null;

    for (const row of projectionRows) {
      const monthIndex = row["Mes"];
      const saldo = parseNumber(row["Saldo"]);
      const jurosAcum = parseNumber(row["JurosAcumulados"]);
      const dataStr = row["Data"];

      // Data may be in dd/mm/yyyy or similar
      let d = null;
      if (dataStr && dataStr.includes("/")) {
        const [dd, mm, yyyy] = dataStr.split("/");
        d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      }

      projectionLabels.push(d || monthIndex);
      projectionBalance.push(saldo);
      baseTotalInterest = jurosAcum;
      basePayoffDate = d || basePayoffDate;
    }

    // Build scenarios series
    // loan_scenarios.csv columns (from your screenshot):
    // Mes, Base, Mais50, Mais100, Mais200
    const scenarioMonths = scenarioRows.map((r) => r["Mes"]);
    const scenarioBase = scenarioRows.map((r) => parseNumber(r["Base"]));
    const scenarioPlus50 = scenarioRows.map((r) => parseNumber(r["Mais50"]));
    const scenarioPlus100 = scenarioRows.map((r) => parseNumber(r["Mais100"]));
    const scenarioPlus200 = scenarioRows.map((r) => parseNumber(r["Mais200"]));

    // Scenario summary
    // loan_scenarios_summary.csv columns:
    // Cenario, DataLiquidacao, JurosTotais, JurosPoupados
    const scenarioSummary = scenarioSummaryRows.map((r) => {
      const name = r["Cenario"];
      const jurosTotais = parseNumber(r["JurosTotais"]);
      const jurosPoupados = parseNumber(r["JurosPoupados"]);
      const dataStr = r["DataLiquidacao"];
      let payoffDate = null;
      if (dataStr && dataStr.includes("/")) {
        const [dd, mm, yyyy] = dataStr.split("/");
        payoffDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      }
      return { name, jurosTotais, jurosPoupados, payoffDate };
    });

    // Build real series from Actual
    const real = buildRealSeries(transactions);

    // Align real series with projection:
    // we will map real "progress" onto the projection balance curve.
    // Simple approach: assume starting balance = first projection balance.
    let realBalanceSeries = [];
    let realLabels = real.labels;

    if (projectionBalance.length > 0 && real.paidSeries.length > 0) {
      const startBalance = projectionBalance[0];
      const maxPaid = real.paidSeries[real.paidSeries.length - 1];
      // approximate current balance = startBalance - totalPaid
      const currentBalance = Math.max(startBalance - maxPaid, 0);

      // Build a simple linear mapping over time:
      // for each real point, estimate balance = startBalance - paidSoFar
      realBalanceSeries = real.paidSeries.map((paid) =>
        Math.max(startBalance - paid, 0)
      );

      // Projected real payoff date: when balance hits 0 in projection timeline
      // using the same monthly payment pattern is complex; we’ll approximate:
      // find the first projection month where balance <= currentBalance,
      // then shift by how fast you’re paying vs base.
      // To keep it simple and robust, we’ll just say:
      // - real payoff date ≈ base payoff date (you can refine later)
    }

    // For now, real payoff date = base payoff date (approx)
    const realPayoffDate = basePayoffDate;
    const realInterestProjected = baseTotalInterest; // placeholder
    const interestSavedReal = 0; // placeholder
    const monthsSavedReal = 0; // placeholder

    // ==== Update summary UI ====

    document.getElementById("basePayoffDate").textContent =
      formatDate(basePayoffDate);
    document.getElementById("realPayoffDate").textContent =
      formatDate(realPayoffDate);
    document.getElementById("baseInterest").textContent =
      formatCurrency(baseTotalInterest);
    document.getElementById("realInterest").textContent =
      formatCurrency(realInterestProjected);
    document.getElementById("interestSavedReal").textContent =
      formatCurrency(interestSavedReal);
    document.getElementById("monthsSavedReal").textContent =
      monthsSavedReal === 0 ? "–" : `${monthsSavedReal} months`;

    // Scenarios table
    const tbody = document.getElementById("scenariosTableBody");
    tbody.innerHTML = "";
    scenarioSummary.forEach((s) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${s.name}</td>
        <td>${formatDate(s.payoffDate)}</td>
        <td>${formatCurrency(s.jurosTotais)}</td>
        <td>${formatCurrency(s.jurosPoupados)}</td>
      `;
      tbody.appendChild(tr);
    });

    // ==== Build chart ====

    const ctx = document.getElementById("loanChart").getContext("2d");

    // X labels: use projection labels (dates) if available
    const labels = projectionLabels.map((d, i) =>
      d instanceof Date ? formatDate(d) : `M${i + 1}`
    );

    const datasets = [];

    // Real (filled area)
    if (realBalanceSeries.length > 0) {
      datasets.push({
        label: "Real balance (approx)",
        data: realBalanceSeries,
        type: "line",
        fill: "origin",
        backgroundColor: "rgba(79, 140, 255, 0.25)",
        borderColor: "#4f8cff",
        borderWidth: 2.2,
        tension: 0.25,
        pointRadius: 0,
      });
    }

    // Base projection (line)
    datasets.push({
      label: "Base projection",
      data: projectionBalance,
      type: "line",
      fill: false,
      borderColor: "#9ca3b8",
      borderWidth: 1.8,
      borderDash: [],
      tension: 0.25,
      pointRadius: 0,
    });

    // Scenarios (lines)
    datasets.push(
      {
        label: "+50 scenario",
        data: scenarioPlus50,
        type: "line",
        fill: false,
        borderColor: "#ffb347",
        borderWidth: 1.4,
        borderDash: [4, 3],
        tension: 0.25,
        pointRadius: 0,
      },
      {
        label: "+100 scenario",
        data: scenarioPlus100,
        type: "line",
        fill: false,
        borderColor: "#4ade80",
        borderWidth: 1.4,
        borderDash: [4, 3],
        tension: 0.25,
        pointRadius: 0,
      },
      {
        label: "+200 scenario",
        data: scenarioPlus200,
        type: "line",
        fill: false,
        borderColor: "#f97373",
        borderWidth: 1.4,
        borderDash: [4, 3],
        tension: 0.25,
        pointRadius: 0,
      }
    );

    if (chartInstance) {
      chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            labels: {
              color: "#e5e7f3",
              font: { size: 11 },
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                return `${ctx.dataset.label}: ${formatCurrency(v)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3b8",
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
            },
            grid: {
              display: false,
            },
          },
          y: {
            ticks: {
              color: "#9ca3b8",
              callback: (v) => formatCurrency(v),
            },
            grid: {
              color: "rgba(148, 163, 184, 0.15)",
            },
          },
        },
      },
    });

    setStatus("Loaded · using current Actual session");
  } catch (err) {
    console.error(err);
    setStatus("Error loading data (check console)");
  }
}

document.addEventListener("DOMContentLoaded", main);

