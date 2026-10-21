# Financial Independence: retirement income implementation

The reusable What-If overlays `fiConfig` on a clone, freezes inherited lifestyle / housing / tuition / childcare / one-off expenses, and calls the same `Model.run` used by all other tabs. Original cases and parameters are not edited. `fiWhatIf` persists separately; Save Configuration creates a new case.

## Social Security

`social-security.js` provides pure functions and per-run earnings state. Each engine run, exit-year candidate and simulation gets fresh state. Historic entries are Social Security-covered nominal annual earnings; missing records are zero, explicitly provisional. Projected earnings are capped W-2 wages plus 92.35% of net SE profit (after existing overhead/home-office assumptions), never equity appreciation, sales proceeds or distributions. Unvested compensation stops under the existing FI exit rules.

The estimator uses 40 insured-status credits; highest 35 indexed years divided by 420 (missing years zero); wage indexing to the age-60 AWI; original 1979 bend points indexed by AWI; PIA weights 90/32/15%; monthly early reduction and delayed credits; annual COLA rounding and subsequent earnings recomputation. Historical AWI/caps are provided for the modern earnings period. Earlier missing series and all future AWI/caps are planning approximations. Published 2026/2027 caps and AWI through 2025 are included. SSA monthly FRA overrides are expressed in plan-start purchasing power and fixed to their quoted earnings assumption. They cannot automatically infer a different future-work assumption from a statement total.

Spousal excess is calculated above own PIA only after the worker claims; no double benefit or delayed credits on the spousal base. Survivor years, optional from age 67, stop the deceased's income/benefit and replace the survivor's own amount with the larger applicable amount, including delayed credits / early-worker widow(er) limitation. Default both survive the full horizon. Survivor federal, SS, NJ and NY base schedules use single status; NY supplemental recapture remains the inherited joint approximation, disclosed in UI. No automatic spending reduction occurs. Early survivor / child-in-care / disability / remarriage strategies are not inferred.

All ages/claims use January 1. Entire pre-FRA years use $1 withholding per $2 of excess earned income; withheld months restore the worker's early reduction at FRA. The assumed January birthday leaves no pre-FRA months in the FRA year. Actual birthdays, special first-year monthly tests and family earnings-test allocations need SSA confirmation. No tax on investment withdrawals is called an earnings-test deduction. The 0/75/100% sensitivity scales current-law payments after withholding, without changing credits or earnings.

Federal tax uses Pub. 915 provisional income and the fixed MFJ $32k/$44k (single $25k/$34k) thresholds, capped at 85% taxable benefits, not an 85% tax. NY/NJ do not tax SS and no payroll tax applies to benefits. Ordinary distribution tax and extra federal tax from realized gains making SS taxable are solved together with asset sales; incremental tax is funded and recorded once. The existing simplified capital-gains rates, pooled basis and NY/NJ allocation remain assumptions, not a tax-return engine.

## Earned income, healthcare and investment funding

Independent regular retirement ages and later-income windows control each person's earnings. Later work begins no sooner than regular retirement and does not stack with regular earnings. End age is inclusive; zero is full retirement. Amounts are nominal in the chosen start-age year, growth begins at that age. Nancy keeps the selected practice overhead and SE treatment. Norm keeps W-2 or consulting treatment. Employer contributions do not resume.

Incremental pre-Medicare household coverage is prorated by the number under 65. From 65, Part B premiums plus B/D IRMAA are separate expenses, not also subtracted from SS. IRMAA uses MAGI two years earlier, including taxable SS, retirement distributions and realized gains. Future premiums and thresholds are indexed assumptions. Part D/supplement/out-of-pocket quotes and a credit for premiums already in the medical budget are editable. Part A assumes premium-free eligibility; ACA subsidies, premium appeals and long-term care are not inferred. Existing medical/lifestyle lines are unchanged.

Tax-deferred retirement withdrawals start at 60 under the existing conservative annual convention; no early-access exception/Roth basis is inferred. RMDs begin at 75. Liquid assets, tender-limited vested Stripe and retirement are funded separately. No sale is invented after assets exhaust: negative liquid balances are cumulative unfunded spending, without borrowing returns or phantom gain taxes.

## Future-public private investments

The FI What-If now includes the existing `otherAssets` pool (excluding vested Stripe) as a separately modeled, optionally saleable investment. Default assumption: first saleable year 2034, 100% of the pool becomes tradable, original tax basis equal to 25% of the plan's starting private asset value. These are editable and provisional; no IPO, lockup expiration, secondary transaction, exit valuation or tax basis is guaranteed.

Before the liquidity date, these holdings remain in total net worth but not accessible investments or the spending waterfall. From the later of the liquidity year and FI transition, the configured share is marked tradable and its estimated *after-tax* value counts toward FI accessible investments, exit tests, milestones and comparisons. The remainder stays locked. When funding is required, the engine sells from the tradable pool only after ordinary liquid/Stripe sources, recognizes proportional original basis, deducts estimated capital-gains tax and includes realized gains in the federal Social Security taxation calculation. Unsold private investments continue to appreciate under the inherited diversified return assumption. Neither an IPO nor becoming tradable automatically creates cash, a taxable event or additional net worth. Original non-FI cases are unchanged.

The planner still uses annual liquidity conventions, simplified capital-gains rates and one aggregate private-asset bucket. It cannot establish individual company listing dates, lockup windows, discounts, capital calls, carry, QSBS eligibility, fund distribution waterfalls or concentration risk. For conservative decisions, change the liquidity year/share and compare against a zero-liquidity case.

## Safety and comparison

All runs reach at least age 90 for the younger person. Sustainable requires no unfunded year, the inflation-linked liquid reserve, and the selected maximum annual withdrawal rate throughout that horizon. Borderline is funded but fails a guardrail. The tool also displays the first fully funded exit separately, avoiding a claim that “positive at 70” is sufficient. Each candidate year is actually rerun for all three SS levels.

Added-investment targets solve for a beginning-of-exit-year portfolio top-up using inherited return and pooled basis assumptions. Funding-only and all-criteria targets are distinct; zero means no extra capital, not no required portfolio. Nominal and real minima are computed separately (a nominal minimum deflated at its date is not necessarily the real minimum). Milestones use Norm's age and explicitly include gross retirement assets; access and withdrawal tax are separately modeled.

The existing Monte Carlo engine remains optional and conditional. Zero-volatility equivalence to the deterministic engine is tested. Its frequency of avoiding an unfunded year is not presented as a calibrated probability of satisfying every safety rule.

## Primary references

- https://www.ssa.gov/oact/cola/Benefits.html
- https://www.ssa.gov/oact/cola/AWI.html
- https://www.ssa.gov/oact/cola/bendpoints.html
- https://www.ssa.gov/oact/cola/cbb.html
- https://www.ssa.gov/oact/quickcalc/early_late.html
- https://www.ssa.gov/oact/quickcalc/spouse.html
- https://www.ssa.gov/OP_Home/handbook/handbook.04/handbook-0407.html
- https://www.ssa.gov/benefits/retirement/planner/whileworking.html
- https://www.irs.gov/publications/p915
- https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
- https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles
