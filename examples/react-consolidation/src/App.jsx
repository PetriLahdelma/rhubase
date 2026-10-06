import React, { useState } from 'react';
import { Button as CommerceButton, Provider as CommerceProvider } from '../systems/commerce.jsx';
import { Button as AdminButton } from '../systems/admin.jsx';

export function App() {
  const [submits, setSubmits] = useState(0);
  const [actions, setActions] = useState(0);
  const [pressed, setPressed] = useState(false);

  return (
    <CommerceProvider>
      <form
        data-testid="demo-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmits((count) => count + 1);
        }}
      >
        <output data-testid="submit-count">{submits}</output>
        <output data-testid="action-count">{actions}</output>
        <CommerceButton data-testid="submit-action" onAction={() => setActions((count) => count + 1)}>
          Save
        </CommerceButton>
        <AdminButton
          variant="action"
          data-testid="admin-action"
          onAction={() => setActions((count) => count + 1)}
        >
          Run
        </AdminButton>
        <AdminButton
          variant="toggle"
          data-testid="admin-toggle"
          selected={pressed}
          onChange={setPressed}
        >
          Pin
        </AdminButton>
        <AdminButton variant="link" data-testid="admin-link" href="#destination">
          Details
        </AdminButton>
      </form>
      <div id="destination" data-testid="destination">Destination</div>
    </CommerceProvider>
  );
}
