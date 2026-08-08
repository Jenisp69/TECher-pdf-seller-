let selectedRating = 5;

// Handle interactive star rating clicks
document.addEventListener('DOMContentLoaded', () => {
  const stars = document.querySelectorAll('.star-btn');
  
  stars.forEach(star => {
    star.addEventListener('click', (e) => {
      selectedRating = parseInt(e.currentTarget.getAttribute('data-value'), 10);
      stars.forEach(s => {
        const val = parseInt(s.getAttribute('data-value'), 10);
        s.classList.toggle('active', val <= selectedRating);
      });
    });
  });

  // Handle feedback form submission
  const feedbackForm = document.getElementById('feedback-form');
  if (feedbackForm) {
    feedbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const commentInput = document.getElementById('feedback-text-input');
      const comment = commentInput ? commentInput.value.trim() : '';

      // Fallback if currentStudentUser variable isn't globally declared
      const studentName = (typeof currentStudentUser !== 'undefined' && currentStudentUser?.full_name) 
        ? currentStudentUser.full_name 
        : 'Anonymous Student';

      if (!comment) {
        alert('Please write a brief feedback or review before submitting.');
        return;
      }

      try {
        const { error } = await supabaseClient
          .from('feedback')
          .insert([
            { 
              student_name: studentName, 
              rating: selectedRating, 
              comment: comment 
            }
          ]);

        if (error) throw error;

        alert('✅ Thank you! Your feedback has been submitted.');
        feedbackForm.reset();
        
        // Reset stars back to 5
        selectedRating = 5;
        stars.forEach(s => s.classList.add('active'));

      } catch (err) {
        console.error('Feedback submission error:', err);
        alert(`Error submitting feedback: ${err.message}`);
      }
    });
  }
});