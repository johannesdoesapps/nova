from conftest import headers


def test_health_and_auth(client):
    assert client.get("/health").json()["ok"]
    assert client.get("/lab/workflows").status_code == 401
    r = client.get("/lab/workflows", headers={"X-Orbis-Identity": "garbage.sig"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"


def test_goal_to_run_flow(client):
    h = headers()
    plan = client.post("/lab/plan", json={"goal": "Summarise the latest research on sleep and memory"}, headers=h).json()
    assert plan["tasks"] and plan["planner"] == "rules"
    comp = client.post("/lab/plan/compile", json={"plan": plan}, headers=h).json()
    assert comp["validation"]["valid"]
    wid = comp["workflow_id"]
    assert client.post(f"/lab/workflows/{wid}/runs", json={}, headers=h).status_code == 409  # must publish first
    assert client.post(f"/lab/workflows/{wid}/publish", json={"changelog": "first"}, headers=h).json()["version"] == 1
    run = client.post(f"/lab/workflows/{wid}/runs", json={"inputs": {}}, headers=h).json()
    assert run["status"] in ("succeeded", "failed")
    assert client.get(f"/lab/runs/{run['id']}", headers=headers("someone-else")).status_code == 404


def test_workspace_and_radar_endpoints(client):
    h = headers()
    w = client.post("/workspaces", json={"name": "API space"}, headers=h).json()
    it = client.post(f"/workspaces/{w['id']}/items", json={"type": "note", "title": "Hello", "data": {"body": "x"}}, headers=h).json()
    assert client.get(f"/workspaces/{w['id']}/items/{it['id']}", headers=h).json()["current_version"] == 1
    assert client.get(f"/workspaces/{w['id']}", headers=headers("intruder")).status_code == 404
    watch = client.post("/radar/watches", json={"name": "AI policy", "query": "AI regulation"}, headers=h).json()
    assert watch["freshness"]["state"] == "never_checked"
    meta = client.get("/radar/meta", headers=h).json()
    assert meta["status"]["scheduler_running"] is False
    cat = client.get("/connectors", headers=h).json()["catalog"]
    assert {c["status"] for c in cat} >= {"available", "planned", "not_planned"}


def test_errors_are_structured(client):
    r = client.post("/lab/validate", json={"name": "x", "nodes": []}, headers=headers())
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"
