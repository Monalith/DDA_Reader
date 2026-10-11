"""Server-side full minimum-time OCP for the DDA Lab virtual rider (spec v2 §2.10).

``job_queue`` is a single-worker background queue (no CasADi import); ``ocp_motorcycle``
is the CasADi direct-collocation solver it runs in a child process.
"""
