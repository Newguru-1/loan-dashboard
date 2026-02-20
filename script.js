/************************************************************
 *  Loan Dashboard — Final Version (Actual + Modal + CSVs)
 ************************************************************/

/* ===========================
   CONFIG
=========================== */

const SERVER_URL = "https://nostalgic-malamute.pikapod.net";
const SYNC_ID = "5fbea9cc-78fc-4d88-bba4-828d81619aca";
const BUDGET_ID = "My-Finances-7b80cf7";
const LOAN_ACCOUNT_NAME = "Volkswagen Financial Services";

// Local CSVs
const CSV_PROJECTION = "loan_projection.csv";
const CSV_SCENARIOS = "loan_scenarios.csv";
const CSV_SCENARIOS_SUMMARY = "loan_scenarios_summary.csv";

/* ===========================
   PASSWORD MODAL (Styled)
=========================== */

function showPasswordModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  backdrop.innerHTML = `
    <div class="modal-box">
      <h2>Actual Budget</h2>
      <p>Introduz a password para ligar ao servidor</p>

      <input id="actualPasswordInput" 
             type="password" 
             class="modal-input"
             placeholder="Password" />

      <button id="actualPasswordBtn" class="modal-button">
        Ligar
      </button>

      <div id="passwordError" class="modal-error">
        Password incorreta
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  document.getElementById("actualPasswordBtn").onclick = () => {
    const pwd = document.getElementById("actualPasswordInput").value.trim();
    if (!pwd) return;

    backdrop.style.pointerEvents = "none";
    backdrop.style.opacity = "0.85";

    connectToActual(pwd)
      .then(() => {
        backdrop.remove();
        loadDashboardData();
      })
      .catch(() => {
        backdrop.style.pointerEvents = "auto";
        backdrop.style.opacity = "1";
        document.getElementById("passwordError").style.display = "block";
      });
  };
}

/* ===========================
   ACTUAL BUDGET API
=========================== */

let actualTransactions = [];

async function connectToActual(password) {
  // 1) Sync
  const syncRes = await fetch(`${SERVER_URL}/sync/${SYNC_ID}`, {
    method: "POST",
    headers: { "X-Actual-Password": password }
  });

  if (!syncRes.ok) throw new Error("Sync failed");

  // 2) Fetch transactions
  const budgetRes = await fetch(
    `${SERVER_URL}/api/v1/budget/${BUDGET_ID}/transactions`,
    { headers: { "X-Actual-Password": password } }
  );

  if (!budgetRes.ok) throw new Error("Budget fetch failed");

  const data = await budgetRes.json();

  actualTransactions = data.filter(
    t => t.account === LOAN_ACCOUNT_NAME
  );
}

/* ===========================
   CSV PARSING
=========================== */

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];

  const headers = lines[0].split(";").map(h => h.trim());

  return lines.slice(1).map(line => {
    const cols = line.split(";");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (cols[i] ?? "").trim();
    });
    return obj;
  });
}

async function loadCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("CSV not found: " + url);
  return parseCSV(await res.text());
}

/* ===========================
   REAL BALANCE FROM ACTUAL
=========================== */

function computeRealBalance() {
  const sorted = [...actualTransactions].sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  let balance = 0;
  const points = [];

  for (const t of sorted) {
    balance += t.amount;
    points.push({
      date: new Date(t.date),
      balance: balance
    });
  }

  return points;
}

/* ===========================
   DASHBOARD MAIN LOGIC
=========================== */

async function loadDashboardData() {
  document.getElementById("statusText").textContent = "Loading CSVs…";

  const [projection, scenarios, summary] = await Promise.all([
    loadCSV(CSV_PROJECTION),
    loadCSV(CSV_SCENARIOS),
    loadCSV(CSV_SCENARIOS_SUMMARY)
  ]);

  document.getElementById("statusText").textContent = "Processing…";

  const real = computeRealBalance();

  drawChart(real, projection, scenarios);
  fillSummary(real, projection, summary);
  fillScenariosTable(summary);

  document.getElementById("statusText").textContent = "Ready";
}

/* ===========================
   CHART
=========================== */

let chart;

function drawChart(real, projection, scenarios) {
  const ctx = document.getElementById("loanChart");

  const realData = real.map(p => ({
    x: p.date,
    y: p.balance
  }));

  const baseData = projection.map(r => ({
    x: new Date(r.Data),
    y: Number(r.Saldo.replace(",", "."))
  }));

  const scenarioNames = [...new Set(scenarios.map(s => s.Scenario))];

  const scenarioDatasets = scenarioNames.map(name => {
    const rows = scenarios.filter(s => s.Scenario === name);
    return {
      label: name,
      data: rows.map(r => ({
        x: new Date(r.Data),
        y: Number(r.Saldo.replace(",", "."))
      })),
      borderWidth: 2,
      borderColor: randomColor(),
      fill: false
    };
  });

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Real",
          data: realData,
          borderColor: "#0078ff",
          backgroundColor: "rgba(0,120,255,0.3)",
          fill: true,
          borderWidth: 2
        },
        {
          label: "Base",
          data: baseData,
          borderColor: "#ff9900",
          borderWidth: 2,
          fill: false
        },
        ...scenarioDatasets
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { type: "time", time: { unit: "month" } },
        y: { beginAtZero: false }
      }
    }
  });
}

function randomColor() {
  return `hsl(${Math.random() * 360}, 70%, 50%)`;
}

/* ===========================
   SUMMARY
=========================== */

function fillSummary(real, projection, summary) {
  const base = summary.find(s => s.Scenario === "Base");

  document.getElementById("basePayoffDate").textContent = base.PayoffDate;
  document.getElementById("baseInterest").textContent = base.TotalInterest;

  const realLast = real[real.length - 1];
  document.getElementById("realPayoffDate").textContent =
    realLast ? realLast.date.toISOString().slice(0, 10) : "-";

  document.getElementById("realInterest").textContent = "-";
  document.getElementById("interestSavedReal").textContent = "-";
  document.getElementById("monthsSavedReal").textContent = "-";
}

/* ===========================
   SCENARIOS TABLE
=========================== */

function fillScenariosTable(summary) {
  const tbody = document.getElementById("scenariosTableBody");
  tbody.innerHTML = "";

  summary.forEach(row => {
    if (row.Scenario === "Base") return;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.Scenario}</td>
      <td>${row.PayoffDate}</td>
      <td>${row.TotalInterest}</td>
      <td>${row.InterestSaved}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ===========================
   START
=========================== */

window.onload = () => {
  showPasswordModal();
};
