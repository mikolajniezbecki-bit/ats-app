// The cost alert (tech-stack.md M8): resource-group scope, so the deploy
// service principal can create it; in the subscription's billing currency;
// notifies at 80 % and 100 % of actual cost and never stops anything.
param name string
param amount int
@description('First day of a month (yyyy-MM-01). Committed once, so reruns keep the same budget period.')
param startDate string
param alertEmail string

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: name
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [
          alertEmail
        ]
      }
      actual100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [
          alertEmail
        ]
      }
    }
  }
}
