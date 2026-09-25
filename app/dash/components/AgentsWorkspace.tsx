import styles from "./agents-workspace.module.css";

const agents = [
  {
    id: "sales",
    title: "Sales",
    description: "What's selling, and where revenue is moving.",
    image: "/agents/sales.png",
  },
  {
    id: "customers",
    title: "Customers",
    description: "Who buys, who returns, and who to look after.",
    image: "/agents/customers.png",
  },
  {
    id: "inventory",
    title: "Inventory",
    description: "Stock levels, ageing, and what to reorder.",
    image: "/agents/inventory.png",
  },
  {
    id: "profit",
    title: "Profit",
    description: "Margin, costs, and where money is leaking.",
    image: "/agents/profit.png",
  },
  {
    id: "employees",
    title: "Employees",
    description: "Roster, hours, and how the team is performing.",
    image: "/agents/employees.png",
  },
  {
    id: "workshop",
    title: "Workshop",
    description: "Jobs, bookings, and workshop throughput.",
    image: "/agents/workshop.png",
  },
] as const;

type AgentsWorkspaceProps = Readonly<{
  onStartSalesSwarm: () => void;
  salesSwarmBusy: boolean;
}>;

export default function AgentsWorkspace({
  onStartSalesSwarm,
  salesSwarmBusy,
}: AgentsWorkspaceProps) {
  return (
    <div className={styles.workspace} aria-label="Agents">
      <div className={styles.grid}>
        {agents.map((agent) => (
          <article className={styles.card} key={agent.id} aria-labelledby={`agent-${agent.id}`}>
            <img
              src={`${agent.image}?v=3`}
              alt=""
              width={320}
              height={320}
              className={styles.icon}
            />
            <h2 id={`agent-${agent.id}`}>{agent.title}</h2>
            <p>{agent.description}</p>
            {agent.id === "sales" ? (
              <button
                className={styles.swarmButton}
                type="button"
                disabled={salesSwarmBusy}
                onClick={onStartSalesSwarm}
              >
                {salesSwarmBusy ? "Working" : "Swarm"}
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
