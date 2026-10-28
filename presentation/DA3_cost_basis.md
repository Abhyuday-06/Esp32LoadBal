# DA3 cost comparison basis

Reference date: 28 October 2026. All hardware figures below are reference prices or budget estimates, not the team's purchase invoices. The comparison concerns the incremental gateway, not the whole backend application.

## Hardware

| Item | DA2 budget estimate | DA3 retailer list price, including GST |
| --- | ---: | ---: |
| ESP32 development board | INR 350 | INR 425 |
| Raspberry Pi 4 Model B, 2 GB | INR 4,200 | INR 7,091 |

DA2 estimates come from `data/project_data.json`, `hardware_comparison.devices`. They are historical assumptions, not refreshed vendor quotes. The DA2 mini-PC estimate of INR 13,000 is not used for a current procurement comparison because it has no specific configuration or refreshed quote.

DA3 retailer references:

- ESP32, 30-pin CP2102 development board, SKU TIFCC0162: https://robocraze.com/products/nodemcu-32-wifi-bluetooth-esp32-development-board30-pin
- Raspberry Pi 4, 2 GB, SKU TIFC00062: https://robocraze.com/products/raspberry-pi-4-model-b-2gb-ram

Both listings show sold out. These are listed-price comparisons, not available-to-buy quotations. Prices include GST and exclude delivery. The ESP32 listing is a comparable 30-pin development board, not proof of the team's exact board supplier.

DA2 saving relative to the Pi estimate: `(4200 - 350) / 4200 = 91.6667%`.

DA3 listed-price difference: `7091 - 425 = INR 6666`. Relative difference: `6666 / 7091 = 94.0065%`.

The incremental prototype budget is INR 425 plus delivery **only if** the USB cable/power source, laptop/backend servers and Wi-Fi network are already available and reused. Add their actual costs when purchasing them. A standalone enclosure, dedicated power adapter, installation and support are outside this subtotal. A Pi deployment also needs boot storage and power accessories. No accessory-cost saving is quantified without quotes.

## Electricity and three-year sensitivity model

Assumptions:

- Continuous operation for 8,760 hours/year.
- Electricity tariff INR 8/kWh, an illustrative assumption rather than a quoted local tariff.
- ESP32: 0.79 W, retained from the DA2 planning estimate. The repository explicitly marks ESP32 power as `pending_measurement`. This is not a measured proxy draw or a datasheet-board power claim.
- Pi 4: 2.7 W idle to 6.4 W at full CPU stress, published by the original benchmark author: https://www.pidramble.com/wiki/benchmarks/power-consumption.html
- The Pi values describe different benchmark states, not the same proxy workload. The range is a sensitivity analysis, not a matched energy-efficiency experiment.

`Annual energy (kWh) = W / 1000 * 8760`.

`Annual electricity cost (INR) = annual energy * 8`.

`Three-year board + electricity (INR) = reference board price + 3 * annual electricity cost`.

| Metric | ESP32 planning case | Pi 4 sensitivity range |
| --- | ---: | ---: |
| Annual energy | 6.9204 kWh | 23.652 to 56.064 kWh |
| Annual electricity | INR 55.3632 | INR 189.216 to 448.512 |
| Three-year board + electricity | INR 591.0896 | INR 7,658.648 to 8,436.536 |

Slide figures round these to 6.9 / 23.7–56.1 kWh, INR 55 / 189–449 yearly, and INR 591 / 7,659–8,437 over three years. This excludes backend/laptop/network electricity, accessories, delivery, maintenance, deployment and downtime. It is not full-system total cost of ownership. No energy-savings percentage is asserted from unmatched workloads.

## Recurring service cost and scope

AWS's official US-East-1 Application Load Balancer pricing examples use a base rate of USD 0.0225 per hour: https://aws.amazon.com/elasticloadbalancing/pricing/

`0.0225 * 8760 = USD 197.10/year` in base balancer charges before capacity usage, public IPv4/data charges where applicable, taxes and credits. This is an example recurring charge, not a feature-equivalent replacement benchmark. A managed balancer offers capabilities and capacity beyond the prototype.

The local ESP32 firmware requires no managed-balancer service subscription. Existing backend compute, Wi-Fi, power and support still incur costs. If spare capacity already exists on a server running a free software proxy, the additional gateway hardware purchase may be zero and a new ESP32 does not produce a capital saving against that option.

Q-learning, EMA and Round Robin use the same board. Q-table persistence reuses onboard flash, with no added storage component in the described implementation. The measured latency improvement demonstrates performance at the same board cost. It does not establish fewer required backend servers, reduced cloud billing, or a measured financial saving from reinforcement learning alone.
