"""A very small linear-programming layer over SciPy's HiGHS solver.

Variables and constraints are added by name, so the optimiser reads like the
maths and every binding constraint can be reported back by name.
"""
from dataclasses import dataclass

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import csr_matrix

BIG = 1e30


@dataclass
class Solution:
    status: str
    objective: float
    x: dict            # variable name -> value
    reduced_cost: dict  # variable name -> reduced cost (objective change per unit, at its bound)
    dual: dict         # constraint name -> shadow price
    slack: dict        # constraint name -> distance from the bound


class LP:
    def __init__(self) -> None:
        self.names: list[str] = []
        self.index: dict[str, int] = {}
        self.lb: list[float] = []
        self.ub: list[float] = []
        self.cost: list[float] = []
        self._ub_rows: list[tuple[dict, float, str]] = []   # sum(coef * x) <= rhs
        self._eq_rows: list[tuple[dict, float, str]] = []   # sum(coef * x) == rhs

    def var(self, name: str, lb: float = 0.0, ub: float | None = None, cost: float = 0.0) -> str:
        if name in self.index:
            raise ValueError(f"duplicate variable {name}")
        if ub is not None and ub < lb - 1e-9:
            raise ValueError(f"{name}: upper bound {ub} below lower bound {lb}")
        self.index[name] = len(self.names)
        self.names.append(name)
        self.lb.append(lb)
        self.ub.append(BIG if ub is None else max(ub, lb))
        self.cost.append(cost)
        return name

    def add_cost(self, name: str, cost: float) -> None:
        self.cost[self.index[name]] += cost

    def le(self, coefs: dict[str, float], rhs: float, name: str) -> None:
        self._ub_rows.append((coefs, rhs, name))

    def ge(self, coefs: dict[str, float], rhs: float, name: str) -> None:
        self._ub_rows.append(({k: -v for k, v in coefs.items()}, -rhs, name))

    def eq(self, coefs: dict[str, float], rhs: float, name: str) -> None:
        self._eq_rows.append((coefs, rhs, name))

    def _matrix(self, rows: list) -> tuple[csr_matrix | None, np.ndarray | None]:
        if not rows:
            return None, None
        r, c, v = [], [], []
        for i, (coefs, _, _) in enumerate(rows):
            for k, val in coefs.items():
                if val != 0.0:
                    r.append(i)
                    c.append(self.index[k])
                    v.append(val)
        return csr_matrix((v, (r, c)), shape=(len(rows), len(self.names))), np.array([row[1] for row in rows])

    def solve(self) -> Solution:
        a_ub, b_ub = self._matrix(self._ub_rows)
        a_eq, b_eq = self._matrix(self._eq_rows)
        res = linprog(np.array(self.cost), A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=b_eq,
                      bounds=list(zip(self.lb, [None if u >= BIG else u for u in self.ub])), method="highs")
        if res.status != 0:
            return Solution(res.message, float("nan"), {}, {}, {}, {})
        x = dict(zip(self.names, res.x))
        rc = dict(zip(self.names, res.lower.marginals + res.upper.marginals))
        dual, slack = {}, {}
        if a_ub is not None:
            for (_, _, name), d, s in zip(self._ub_rows, res.ineqlin.marginals, res.ineqlin.residual):
                dual[name], slack[name] = float(d), float(s)
        if a_eq is not None:
            for (_, _, name), d in zip(self._eq_rows, res.eqlin.marginals):
                dual[name], slack[name] = float(d), 0.0
        return Solution("optimal", float(res.fun), x, rc, dual, slack)
