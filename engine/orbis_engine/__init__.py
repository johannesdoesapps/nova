"""ORBIS AI engine.

A Python service that runs the long-lived and background parts of ORBIS AI:
AI Lab workflows (Part 7), Signal & Opportunity Radar (Part 8), and project
workspaces, community and connectors (Part 9). The Next.js app remains the
user-facing web tier and authenticates users; it calls this service with a
signed identity header (see auth.py).
"""

__version__ = "0.1.0"
