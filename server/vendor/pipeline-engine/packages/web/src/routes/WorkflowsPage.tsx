import { WorkflowList } from '@/components/workflows/WorkflowList';

export function WorkflowsPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden px-4 pb-0 pt-2">
        <WorkflowList />
      </div>
    </div>
  );
}
